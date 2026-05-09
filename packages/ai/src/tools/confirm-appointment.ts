import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'

const InputSchema = z.object({
  doctorId: z.string().uuid(),
  patientId: z.string().uuid(),
  startAt: z
    .string()
    .datetime({ offset: true })
    .describe('ISO 8601 UTC do início. Use slot retornado por check_availability.'),
  durationMinutes: z.number().int().min(15).max(180).optional()
    .describe('Override consultation_duration_minutes do doctor. Em geral, deixa undefined.'),
  notes: z.string().max(500).optional(),
})

const TZ_DEFAULT = 'America/Sao_Paulo'

/**
 * AI-4: Cria booking no Cal.com + INSERT em appointments + system message.
 *
 * Atomicidade compensatória:
 *   1. createBooking no Cal.com (recebe uid)
 *   2. INSERT appointments (calcom_uid + calcom_booking_id)
 *   3. INSERT message system "📅 agendada"
 *   4. Audit log (best-effort)
 *
 * Se step 2 falhar após Cal.com OK → cancelBooking (compensação) + re-throw.
 * Se step 3 falhar → DB row já existe; webhook BOOKING_CREATED pode até
 * vir antes do nosso INSERT (race), worker é idempotente em ON CONFLICT.
 *
 * Email policy híbrida (Gabriel 2026-05-08): patients.email se != null
 * caso contrário placeholder ${patientId}@whatsapp.medina.app.
 */
export function buildConfirmAppointmentTool(ctx: ToolContext) {
  return createTool({
    id: 'confirm_appointment',
    description:
      'Confirma agendamento no Cal.com + cria registro local. Use APÓS check_availability retornar slot e paciente confirmar. Não chame se paciente ainda está escolhendo horário.',
    inputSchema: InputSchema,
    execute: async (inputData) => {
      const { doctorId, patientId, startAt, durationMinutes, notes } = inputData as z.infer<
        typeof InputSchema
      >
      const { supabase, clinicId, conversationId, calcomClient, calcomDefaultEventTypeId } = ctx

      if (!calcomClient) {
        return {
          ok: false as const,
          error: 'calcom_not_configured' as const,
          message: 'Integração Cal.com não configurada.',
        }
      }

      // Cross-tenant lookup paralelo doctor + patient.
      const [docResult, patResult] = await Promise.all([
        supabase
          .from('doctors')
          .select('id, calcom_user_id, calcom_event_type_ids, full_name, consultation_duration_minutes')
          .eq('id', doctorId)
          .eq('clinic_id', clinicId)
          .maybeSingle(),
        supabase
          .from('patients')
          .select('id, full_name, email')
          .eq('id', patientId)
          .eq('clinic_id', clinicId)
          .maybeSingle(),
      ])

      if (docResult.error)
        throw new Error(`confirm_appointment: doctor lookup: ${docResult.error.message}`)
      if (patResult.error)
        throw new Error(`confirm_appointment: patient lookup: ${patResult.error.message}`)
      if (!docResult.data) {
        return { ok: false as const, error: 'doctor_not_found' as const, message: 'Médico não encontrado.' }
      }
      if (!patResult.data) {
        return { ok: false as const, error: 'patient_not_found' as const, message: 'Paciente não encontrado.' }
      }

      const doctor = docResult.data as {
        id: string
        calcom_user_id: string | null
        calcom_event_type_ids: string[] | null
        full_name: string
        consultation_duration_minutes: number
      }
      const patient = patResult.data as {
        id: string
        full_name: string
        email: string | null
      }

      const eventTypeIdStr =
        doctor.calcom_event_type_ids?.[0] ?? calcomDefaultEventTypeId?.toString()
      const eventTypeId = eventTypeIdStr ? Number(eventTypeIdStr) : NaN
      if (!Number.isFinite(eventTypeId)) {
        return {
          ok: false as const,
          error: 'doctor_not_calcom_linked' as const,
          message: `Médico ${doctor.full_name} não tem agenda Cal.com configurada.`,
        }
      }

      // Email híbrida: real ou placeholder.
      const attendeeEmail = patient.email ?? `${patient.id}@whatsapp.medina.app`

      // Defesa: schema já valida ISO 8601, mas garantimos parsing antes do
      // side-effect remoto pra evitar booking órfão se um caller bypassar
      // InputSchema.
      const parsedStartAt = new Date(startAt)
      if (Number.isNaN(parsedStartAt.getTime())) {
        return {
          ok: false as const,
          error: 'invalid_start_at' as const,
          message: 'Horário inválido.',
        }
      }
      const normalizedStartAt = parsedStartAt.toISOString()

      // Step 1: Cal.com createBooking.
      const booking = await calcomClient.createBooking({
        eventTypeId,
        start: normalizedStartAt,
        attendee: { email: attendeeEmail, name: patient.full_name, timeZone: TZ_DEFAULT },
        metadata: { conversationId, source: 'medina_agent' },
      })

      // Step 2: INSERT appointment local. Compensação se falhar.
      const duration = durationMinutes ?? doctor.consultation_duration_minutes
      const endAt = new Date(parsedStartAt.getTime() + duration * 60_000).toISOString()

      const { data: apptInserted, error: insErr } = await supabase
        .from('appointments')
        .insert({
          clinic_id: clinicId,
          doctor_id: doctorId,
          patient_id: patientId,
          conversation_id: conversationId,
          status: 'scheduled',
          start_at: normalizedStartAt,
          end_at: endAt,
          timezone: TZ_DEFAULT,
          modality: 'in_person',
          calcom_uid: booking.uid,
          calcom_booking_id: String(booking.id),
          created_via: 'whatsapp',
          notes: notes ?? null,
        })
        .select('id')
        .single()

      if (insErr || !apptInserted) {
        // Compensação: cancela no Cal.com pra evitar booking órfão.
        try {
          await calcomClient.cancelBooking(booking.uid, 'rollback: db insert failed')
        } catch {
          // Compensação falhou — webhook BOOKING_CANCELLED não virá. Só
          // resolveremos no próximo cron de reconciliação (out of scope AI-4).
        }
        throw new Error(`confirm_appointment: db insert failed: ${insErr?.message ?? 'unknown'}`)
      }

      const appointmentId = (apptInserted as { id: string }).id

      // Step 3: system message "📅 agendada".
      const startLocal = parsedStartAt.toLocaleString('pt-BR', { timeZone: TZ_DEFAULT })
      await supabase.from('messages').insert({
        clinic_id: clinicId,
        conversation_id: conversationId,
        direction: 'outbound',
        sender_type: 'system',
        content_type: 'system',
        content: `📅 Consulta agendada com ${doctor.full_name} em ${startLocal}.`,
        delivery_status: 'sent',
        outbox_status: null,
      })

      // Step 4: audit best-effort.
      await supabase.from('audit_logs').insert({
        clinic_id: clinicId,
        user_id: null,
        action: 'agent.tool.confirm_appointment',
        resource: 'appointments',
        resource_id: appointmentId,
        metadata: {
          calcom_uid: booking.uid,
          calcom_booking_id: booking.id,
          doctor_id: doctorId,
          patient_id: patientId,
          start_at: normalizedStartAt,
        },
      })

      return {
        ok: true as const,
        appointmentId,
        calcomUid: booking.uid,
        startAt: normalizedStartAt,
        endAt,
        doctorName: doctor.full_name,
        message: `Consulta confirmada para ${startLocal} com ${doctor.full_name}.`,
      }
    },
  })
}

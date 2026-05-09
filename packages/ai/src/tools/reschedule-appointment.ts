import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'

const InputSchema = z.object({
  appointmentId: z.string().uuid(),
  newStartAt: z.string().describe('Novo início ISO 8601 UTC. Use slot retornado por check_availability.'),
  reason: z.string().max(500).optional(),
})

const TZ_DEFAULT = 'America/Sao_Paulo'

/**
 * AI-4: Remarca via Cal.com (cria novo booking + cancela antigo) + UPDATE local.
 *
 * Cal.com self-host gera novo `uid` no reschedule. Atualizamos
 * appointments.calcom_uid + start_at (mantém o mesmo appointment.id).
 *
 * Sem rollback complexo: se UPDATE falhar após Cal.com OK, audit
 * partial_failure + webhook BOOKING_RESCHEDULED do Cal.com vai resolver
 * o drift no worker (idempotente por calcom_uid).
 */
export function buildRescheduleAppointmentTool(ctx: ToolContext) {
  return createTool({
    id: 'reschedule_appointment',
    description:
      'Remarca uma consulta existente para novo horário. Use APÓS check_availability confirmar slot. Mantém o mesmo paciente e médico, só muda o horário.',
    inputSchema: InputSchema,
    execute: async (inputData) => {
      const { appointmentId, newStartAt, reason } = inputData as z.infer<typeof InputSchema>
      const { supabase, clinicId, conversationId, calcomClient } = ctx

      if (!calcomClient) {
        return { ok: false as const, error: 'calcom_not_configured' as const }
      }

      const { data: appt, error: apptErr } = await supabase
        .from('appointments')
        .select(
          'id, status, calcom_uid, doctor_id, start_at, end_at, timezone, consultation_duration_minutes:doctor_id',
        )
        .eq('id', appointmentId)
        .eq('clinic_id', clinicId)
        .maybeSingle()

      if (apptErr) throw new Error(`reschedule_appointment: lookup: ${apptErr.message}`)
      if (!appt) {
        return {
          ok: false as const,
          error: 'appointment_not_found' as const,
          message: 'Consulta não encontrada nesta clínica.',
        }
      }
      const apptRow = appt as {
        id: string
        status: string
        calcom_uid: string | null
        doctor_id: string
        start_at: string
        end_at: string
      }

      if (apptRow.status.startsWith('cancelled') || apptRow.status === 'completed') {
        return {
          ok: false as const,
          error: 'cannot_reschedule_terminal' as const,
          message: `Consulta em status ${apptRow.status} — não pode ser remarcada.`,
        }
      }

      if (!apptRow.calcom_uid) {
        return {
          ok: false as const,
          error: 'no_calcom_uid' as const,
          message: 'Consulta sem vínculo Cal.com — remarcação manual necessária.',
        }
      }

      // Step 1: Cal.com reschedule → novo uid.
      const newBooking = await calcomClient.rescheduleBooking(apptRow.calcom_uid, newStartAt)

      // Step 2: UPDATE local. Preserva duração original.
      const oldDurationMs = new Date(apptRow.end_at).getTime() - new Date(apptRow.start_at).getTime()
      const newEndAt = new Date(new Date(newStartAt).getTime() + oldDurationMs).toISOString()

      const { error: updErr } = await supabase
        .from('appointments')
        .update({
          start_at: newStartAt,
          end_at: newEndAt,
          calcom_uid: newBooking.uid,
          calcom_booking_id: String(newBooking.id),
          status: 'rescheduled',
          updated_at: new Date().toISOString(),
        })
        .eq('id', appointmentId)
        .eq('clinic_id', clinicId)

      if (updErr) {
        await supabase.from('audit_logs').insert({
          clinic_id: clinicId,
          user_id: null,
          action: 'agent.tool.reschedule_appointment.partial_failure',
          resource: 'appointments',
          resource_id: appointmentId,
          metadata: {
            old_calcom_uid: apptRow.calcom_uid,
            new_calcom_uid: newBooking.uid,
            db_error: updErr.message,
          },
        })
        throw new Error(`reschedule_appointment: db update: ${updErr.message}`)
      }

      // Step 3: system message.
      const newLocal = new Date(newStartAt).toLocaleString('pt-BR', { timeZone: TZ_DEFAULT })
      const reasonNote = reason ? ` Motivo: ${reason}` : ''
      await supabase.from('messages').insert({
        clinic_id: clinicId,
        conversation_id: conversationId,
        direction: 'outbound',
        sender_type: 'system',
        content_type: 'system',
        content: `🔄 Consulta remarcada para ${newLocal}.${reasonNote}`,
        delivery_status: 'sent',
        outbox_status: null,
      })

      // Step 4: audit.
      await supabase.from('audit_logs').insert({
        clinic_id: clinicId,
        user_id: null,
        action: 'agent.tool.reschedule_appointment',
        resource: 'appointments',
        resource_id: appointmentId,
        metadata: {
          old_calcom_uid: apptRow.calcom_uid,
          new_calcom_uid: newBooking.uid,
          old_start_at: apptRow.start_at,
          new_start_at: newStartAt,
          reason,
        },
      })

      return {
        ok: true as const,
        appointmentId,
        newStartAt,
        newCalcomUid: newBooking.uid,
        message: `Consulta remarcada para ${newLocal}.`,
      }
    },
  })
}

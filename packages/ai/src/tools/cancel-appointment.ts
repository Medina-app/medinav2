import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'

const InputSchema = z.object({
  appointmentId: z.string().uuid(),
  reason: z.string().min(3).max(500),
})

const TZ_DEFAULT = 'America/Sao_Paulo'

/**
 * AI-4: Cancela appointment no Cal.com + transition status local.
 *
 * Fluxo:
 *   1. SELECT appointment com cross-tenant guard (clinic_id eq)
 *   2. cancelBooking no Cal.com (graceful em 404 — booking já cancelado externamente)
 *   3. RPC transition_appointment_status('cancelled_by_patient') — state machine
 *      + cascade reminders (definida em 0008)
 *   4. INSERT message system "❌ cancelada"
 *   5. Audit log
 *
 * Não há rollback de step 2: se 3 falhar, audit `partial_failure` registra
 * o drift — webhook BOOKING_CANCELLED da próxima vez resolverá.
 */
export function buildCancelAppointmentTool(ctx: ToolContext) {
  return createTool({
    id: 'cancel_appointment',
    description:
      'Cancela uma consulta agendada. Use quando paciente pedir explicitamente cancelamento. Cancela tanto no Cal.com quanto no sistema interno; lembretes pendentes são cancelados em cascade.',
    inputSchema: InputSchema,
    execute: async (inputData) => {
      const { appointmentId, reason } = inputData as z.infer<typeof InputSchema>
      const { supabase, clinicId, conversationId, calcomClient } = ctx

      if (!calcomClient) {
        return { ok: false as const, error: 'calcom_not_configured' as const }
      }

      // Cross-tenant lookup.
      const { data: appt, error: apptErr } = await supabase
        .from('appointments')
        .select('id, status, calcom_uid, doctor_id, start_at')
        .eq('id', appointmentId)
        .eq('clinic_id', clinicId)
        .maybeSingle()

      if (apptErr) throw new Error(`cancel_appointment: lookup: ${apptErr.message}`)
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
      }

      if (apptRow.status.startsWith('cancelled')) {
        return {
          ok: false as const,
          error: 'already_cancelled' as const,
          message: 'Consulta já está cancelada.',
        }
      }

      // Step 2: Cal.com cancel — graceful em 404 (booking já cancelado externamente).
      let calcomCancelOk = false
      if (apptRow.calcom_uid) {
        try {
          await calcomClient.cancelBooking(apptRow.calcom_uid, reason)
          calcomCancelOk = true
        } catch (err) {
          // CalBookingNotFoundError → seguimos pra cancelar local mesmo assim.
          // Outros erros propagam.
          if (
            err instanceof Error &&
            (err.name === 'CalBookingNotFoundError' || err.message.includes('not found'))
          ) {
            calcomCancelOk = true // tratamos como sucesso pra prosseguir
          } else {
            throw err
          }
        }
      } else {
        // Appointment sem calcom_uid (manual ou origem não-Cal.com). Apenas
        // local cancel.
        calcomCancelOk = true
      }

      // Step 3: RPC transition_appointment_status.
      const { error: rpcErr } = await supabase.rpc('transition_appointment_status', {
        p_appointment_id: appointmentId,
        p_new_status: 'cancelled_by_patient',
        p_reason: reason,
      })

      if (rpcErr) {
        // Audit partial_failure pra debug (Cal.com cancelou mas local falhou).
        await supabase.from('audit_logs').insert({
          clinic_id: clinicId,
          user_id: null,
          action: 'agent.tool.cancel_appointment.partial_failure',
          resource: 'appointments',
          resource_id: appointmentId,
          metadata: {
            calcom_cancel_ok: calcomCancelOk,
            db_error: rpcErr.message,
            reason,
          },
        })
        throw new Error(`cancel_appointment: db transition: ${rpcErr.message}`)
      }

      // Step 4: system message.
      const startLocal = new Date(apptRow.start_at).toLocaleString('pt-BR', { timeZone: TZ_DEFAULT })
      await supabase.from('messages').insert({
        clinic_id: clinicId,
        conversation_id: conversationId,
        direction: 'outbound',
        sender_type: 'system',
        content_type: 'system',
        content: `❌ Consulta de ${startLocal} cancelada. Motivo: ${reason}`,
        delivery_status: 'sent',
        outbox_status: null,
      })

      // Step 5: audit.
      await supabase.from('audit_logs').insert({
        clinic_id: clinicId,
        user_id: null,
        action: 'agent.tool.cancel_appointment',
        resource: 'appointments',
        resource_id: appointmentId,
        metadata: {
          calcom_uid: apptRow.calcom_uid,
          reason,
        },
      })

      return {
        ok: true as const,
        appointmentId,
        message: `Consulta de ${startLocal} cancelada.`,
      }
    },
  })
}

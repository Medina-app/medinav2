import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'

const MAX_WINDOW_DAYS = 7
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000

const InputSchema = z
  .object({
    doctorId: z.string().uuid().describe('UUID do médico em doctors table.'),
    dateFrom: z
      .string()
      .datetime({ offset: true })
      .describe('Início do range a checar. ISO 8601 UTC (ex: 2026-06-01T00:00:00Z).'),
    dateTo: z
      .string()
      .datetime({ offset: true })
      .describe('Fim do range. ISO 8601 UTC. Mantenha < 7 dias pra resposta concisa.'),
  })
  .superRefine((val, ctx) => {
    const from = Date.parse(val.dateFrom)
    const to = Date.parse(val.dateTo)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return
    if (from >= to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateTo'],
        message: 'dateTo deve ser estritamente maior que dateFrom.',
      })
    }
    if (to - from > MAX_WINDOW_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateTo'],
        message: `Janela máxima é ${MAX_WINDOW_DAYS} dias.`,
      })
    }
  })

/**
 * AI-4: Read-only tool. Consulta Cal.com pra slots disponíveis do médico.
 *
 * Retorna até 10 slots (truncado pra resposta concisa do agente — paciente
 * geralmente quer ver "próximos 3-5 horários"). Sem audit log porque é
 * pure read; volume alto.
 */
export function buildCheckAvailabilityTool(ctx: ToolContext) {
  return createTool({
    id: 'check_availability',
    description:
      'Consulta horários disponíveis pra agendar consulta com um médico específico em um intervalo. Use ANTES de confirmar agendamento. Retorna até 10 slots.',
    inputSchema: InputSchema,
    execute: async (inputData) => {
      const { doctorId, dateFrom, dateTo } = inputData as z.infer<typeof InputSchema>
      const { supabase, clinicId, calcomClient, calcomDefaultEventTypeId } = ctx

      if (!calcomClient) {
        return {
          ok: false as const,
          error: 'calcom_not_configured' as const,
          message:
            'Integração Cal.com não configurada nesta clínica. Escala pra atendente humano.',
        }
      }

      // Lookup doctor com cross-tenant guard.
      const { data: doctor, error: docErr } = await supabase
        .from('doctors')
        .select('id, calcom_user_id, calcom_event_type_ids, full_name')
        .eq('id', doctorId)
        .eq('clinic_id', clinicId)
        .maybeSingle()

      if (docErr) throw new Error(`check_availability: doctor lookup failed: ${docErr.message}`)
      if (!doctor) {
        return {
          ok: false as const,
          error: 'doctor_not_found' as const,
          message: 'Médico não encontrado nesta clínica.',
        }
      }

      const docRow = doctor as {
        id: string
        calcom_user_id: string | null
        calcom_event_type_ids: string[] | null
        full_name: string
      }

      // Determine eventTypeId: doctor[0] || clinic default.
      const docEventTypeId = docRow.calcom_event_type_ids?.[0]
      const eventTypeIdStr = docEventTypeId ?? calcomDefaultEventTypeId?.toString()
      const eventTypeId = eventTypeIdStr ? Number(eventTypeIdStr) : NaN

      if (!Number.isFinite(eventTypeId)) {
        return {
          ok: false as const,
          error: 'doctor_not_calcom_linked' as const,
          message: `Médico ${docRow.full_name} não tem agenda Cal.com configurada. Escala pra humano.`,
        }
      }

      const slots = await calcomClient.getAvailability({
        eventTypeId,
        startTime: dateFrom,
        endTime: dateTo,
      })

      // Truncar pra 10 — agente comunica primeiros slots ao paciente; cota
      // resposta no LLM.
      const limited = slots.slice(0, 10)

      return {
        ok: true as const,
        doctorName: docRow.full_name,
        slots: limited,
        totalAvailable: slots.length,
      }
    },
  })
}

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'

const MAX_WINDOW_DAYS = 30
const MAX_DAYS_RETURNED = 3
const MAX_HOURS_PER_DAY = 10

const InputSchema = z
  .object({
    doctorId: z
      .string()
      .uuid()
      .describe('UUID do médico em pep_doctors (catalog local).'),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Início do range em YYYY-MM-DD (formato ANS).'),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Fim do range em YYYY-MM-DD. Mantenha < 30 dias.'),
  })
  .superRefine((val, ctx) => {
    const from = Date.parse(val.dateFrom)
    const to = Date.parse(val.dateTo)
    if (!Number.isFinite(from) || !Number.isFinite(to)) return
    if (from > to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateTo'],
        message: 'dateTo deve ser ≥ dateFrom.',
      })
    }
    if (to - from > MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateTo'],
        message: `Janela máxima é ${MAX_WINDOW_DAYS} dias.`,
      })
    }
  })

/**
 * M1a-2: read-only disponibilidade PEP. Compõe 2 chamadas ANS:
 * 1. `listAvailableDays(doctorAnsId, from, to)` — descobre dias com vaga
 * 2. Pra cada um dos primeiros 3 dias (MAX_DAYS_RETURNED), chama
 *    `listAvailableHours(doctorAnsId, date)` — slots concretos
 *
 * Doctor lookup local (pep_doctors) traduz UUID interno → ans_id externo +
 * cross-tenant guard (clinic_id == ctx.clinicId).
 *
 * Truncamento: máx 3 dias × 10 horários cada = 30 slots no payload — cota
 * resposta do LLM. Frequência da clínica raramente justifica mais.
 *
 * Sem audit log (volume alto, pure read).
 */
export function buildCheckPepAvailabilityTool(ctx: ToolContext) {
  return createTool({
    id: 'check_pep_availability',
    description:
      'Consulta dias e horários disponíveis com um médico PEP no range solicitado. Retorna até 3 dias com até 10 horários cada. Use ANTES de propor agendamento.',
    inputSchema: InputSchema,
    execute: async (inputData) => {
      const { doctorId, dateFrom, dateTo } = inputData as z.infer<typeof InputSchema>
      const { supabase, clinicId, ansClient } = ctx

      if (!ansClient) {
        return {
          ok: false as const,
          error: 'pep_ans_not_configured' as const,
          message:
            'Integração PEP ANS não configurada nesta clínica. Escala pra atendente humano.',
        }
      }

      // Lookup doctor + cross-tenant guard.
      const { data: doctor, error: docErr } = await supabase
        .from('pep_doctors')
        .select('id, ans_id, full_name, active')
        .eq('id', doctorId)
        .eq('clinic_id', clinicId)
        .maybeSingle()

      if (docErr) {
        throw new Error(`check_pep_availability: doctor lookup failed: ${docErr.message}`)
      }
      if (!doctor) {
        return {
          ok: false as const,
          error: 'doctor_not_found' as const,
          message: 'Médico não encontrado nesta clínica.',
        }
      }
      const docRow = doctor as { id: string; ans_id: string; full_name: string; active: boolean }
      if (!docRow.active) {
        return {
          ok: false as const,
          error: 'doctor_inactive' as const,
          message: `Médico ${docRow.full_name} está inativo no momento.`,
        }
      }

      const days = await ansClient.listAvailableDays({
        doctorAnsId: docRow.ans_id,
        from: dateFrom,
        to: dateTo,
      })
      if (days.length === 0) {
        return {
          ok: true as const,
          doctorName: docRow.full_name,
          byDate: {} as Record<string, Array<{ startTime: string; endTime: string }>>,
          totalDaysAvailable: 0,
        }
      }

      const selectedDays = days.slice(0, MAX_DAYS_RETURNED)
      const byDate: Record<string, Array<{ startTime: string; endTime: string }>> = {}
      for (const day of selectedDays) {
        const slots = await ansClient.listAvailableHours({
          doctorAnsId: docRow.ans_id,
          date: day.date,
        })
        byDate[day.date] = slots
          .slice(0, MAX_HOURS_PER_DAY)
          .map((s) => ({ startTime: s.startTime, endTime: s.endTime }))
      }

      return {
        ok: true as const,
        doctorName: docRow.full_name,
        byDate,
        totalDaysAvailable: days.length,
      }
    },
  })
}

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'

const InputSchema = z.object({
  reason: z
    .string()
    .min(3)
    .max(500)
    .describe(
      'Motivo conciso da escalação (e.g., "paciente com urgência médica", "questão fora do escopo do agente", "paciente irritado").',
    ),
})

export function buildEscalateTool(ctx: ToolContext) {
  return createTool({
    id: 'escalate_to_human',
    description:
      'Transfere a conversa pra um atendente humano quando o agente não pode resolver (urgências médicas, questões clínicas específicas, paciente irritado, fora do escopo). Após chamar essa tool, o agente NÃO deve continuar tentando resolver — apenas se despeça brevemente.',
    inputSchema: InputSchema,
    execute: async (inputData) => {
      const { reason } = inputData as z.infer<typeof InputSchema>
      const { supabase, clinicId, conversationId } = ctx

      // PR-A: single atomic RPC. State change + escalated_via='ai' + system
      // message + audit_logs all happen in one Postgres transaction inside
      // public.escalate_conversation. Cross-tenant violation, idempotency,
      // and state validation are enforced inside the function — caller just
      // reads the boolean (true = escalated, false = was already in
      // waiting_human) or propagates the RPC error.
      //
      // AI-5: tool-call escalation deliberately uses the 3-arg RPC and stores
      // escalated_reason=NULL. Guardrail-driven escalation (pre-filter or
      // urgency-detector hit) goes through the 4-arg
      // escalate_conversation_with_reason RPC via the dispatcher with a
      // structured category. Free-text LLM reason vs. structured guardrail
      // category are distinct paths by design — LLM is creative, guardrails
      // are an enum tied to UI badges + dashboard reporting.
      const { data, error } = await supabase.rpc('escalate_conversation', {
        p_conversation_id: conversationId,
        p_clinic_id: clinicId,
        p_reason: reason,
      })
      if (error) throw new Error(`escalate: ${error.message}`)

      if (data === false) {
        return {
          ok: false as const,
          error: 'já_transferida' as const,
          message: 'Conversa já está com humano.',
        }
      }

      return {
        ok: true as const,
        message:
          'Conversa transferida pra humano. Despeça-se brevemente e não continue tentando ajudar.',
      }
    },
  })
}

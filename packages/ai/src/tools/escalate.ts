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

interface ConvRow { id: string; state: string; clinic_id: string }

export function buildEscalateTool(ctx: ToolContext) {
  return createTool({
    id: 'escalate_to_human',
    description:
      'Transfere a conversa pra um atendente humano quando o agente não pode resolver (urgências médicas, questões clínicas específicas, paciente irritado, fora do escopo). Após chamar essa tool, o agente NÃO deve continuar tentando resolver — apenas se despeça brevemente.',
    inputSchema: InputSchema,
    execute: async (inputData) => {
      const { reason } = inputData as z.infer<typeof InputSchema>
      const { supabase, clinicId, conversationId } = ctx

      // 1. Cross-tenant guard: load conversation and verify clinic_id matches.
      const { data: convData, error: cErr } = await supabase
        .from('conversations')
        .select('id, state, clinic_id')
        .eq('id', conversationId)
        .single()
      if (cErr || !convData) {
        throw new Error(`escalate: conversation lookup failed: ${cErr?.message ?? 'not found'}`)
      }
      const conv = convData as ConvRow
      if (conv.clinic_id !== clinicId) {
        throw new Error(
          `escalate: cross-tenant violation — conversation ${conv.id} belongs to ${conv.clinic_id}, not ${clinicId}`,
        )
      }

      // 2. Idempotency: if already escalated, no-op with explicit signal.
      if (conv.state === 'waiting_human') {
        return {
          ok: false as const,
          error: 'já_transferida' as const,
          message: 'Conversa já está com humano.',
        }
      }

      // 3. State transition via RPC. Param names match the deployed function
      //    signature: conv_id, new_state, reason (NOT p_*). Verified via
      //    pg_get_function_arguments — see plan §"Discovered State".
      const { error: rpcErr } = await supabase.rpc('transition_conversation_state', {
        conv_id: conversationId,
        new_state: 'waiting_human',
        reason: `agent_escalated:${reason}`,
      })
      if (rpcErr) throw new Error(`escalate: RPC failed: ${rpcErr.message}`)

      // 4. Insert system message visible in inbox. outbox_status=null because
      //    this is an inbox-only event, not something the outbox worker sends.
      const { error: mErr } = await supabase.from('messages').insert({
        clinic_id: clinicId,
        conversation_id: conversationId,
        direction: 'outbound',
        sender_type: 'system',
        content_type: 'system',
        content: `🤖 IA escalou pra humano: ${reason}`,
        delivery_status: 'sent',
        outbox_status: null,
      })
      if (mErr) throw new Error(`escalate: system message insert failed: ${mErr.message}`)

      // 5. Audit log. transition_conversation_state already audits the state
      //    change — this row records the tool invocation specifically.
      //    user_id is null because the agent runs under service_role.
      await supabase.from('audit_logs').insert({
        clinic_id: clinicId,
        user_id: null,
        action: 'agent.tool.escalate',
        resource: 'conversations',
        resource_id: conversationId,
        metadata: { reason, tool: 'escalate_to_human' },
      })

      return {
        ok: true as const,
        message:
          'Conversa transferida pra humano. Despeça-se brevemente e não continue tentando ajudar.',
      }
    },
  })
}

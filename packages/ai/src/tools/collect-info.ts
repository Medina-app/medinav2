import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'

export const ALLOWED_FIELDS = ['name', 'age', 'reason', 'phone_alt'] as const
type Field = (typeof ALLOWED_FIELDS)[number]

const InputSchema = z.object({
  field: z
    .enum(ALLOWED_FIELDS)
    .describe(
      'Campo que precisa ser perguntado ao paciente. ' +
        'name=nome completo, age=idade, reason=motivo da consulta, phone_alt=telefone alternativo.',
    ),
})

const INSTRUCTIONS: Record<Field, string> = {
  name: 'Peça o nome completo do paciente de forma cordial.',
  age: 'Peça a idade do paciente.',
  reason: 'Peça o motivo da consulta de forma empática.',
  phone_alt: 'Peça um telefone alternativo pra contato.',
}

export function buildCollectInfoTool(ctx: ToolContext) {
  return createTool({
    id: 'collect_patient_info',
    description:
      'Marca que o agente precisa coletar uma informação estruturada do paciente. NÃO preenche dados — apenas estrutura o fluxo conversacional. Retorna instrução pra você fazer a pergunta no próximo turno.',
    inputSchema: InputSchema,
    execute: async (inputData) => {
      const { field } = inputData as z.infer<typeof InputSchema>
      const { supabase, clinicId, conversationId } = ctx

      // Issue #12 fix: chamada atomic via RPC. RPC faz FOR UPDATE lock +
      // jsonb merge num único transaction; cross-tenant guard interno.
      // Substitui o read-modify-write anterior (race condition teórica).
      const { error: rpcErr } = await supabase.rpc('collect_info_atomic', {
        p_conversation_id: conversationId,
        p_clinic_id: clinicId,
        p_field: field,
        p_value: new Date().toISOString(),
      })
      if (rpcErr) {
        throw new Error(`collect_info: ${rpcErr.message}`)
      }

      // Audit complementar (RPC não emite — paralelo ao pattern dos outros
      // tools como escalate). Service_role insert direto.
      await supabase.from('audit_logs').insert({
        clinic_id: clinicId,
        user_id: null,
        action: 'agent.tool.collect_info',
        resource: 'conversations',
        resource_id: conversationId,
        metadata: { field, tool: 'collect_patient_info' },
      })

      return { ok: true as const, field, instruction: INSTRUCTIONS[field] }
    },
  })
}

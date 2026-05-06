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

interface ConvRow {
  metadata: Record<string, unknown> | null
  clinic_id: string
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

      // Cross-tenant guard via dual eq filter on clinic_id.
      const { data: convData, error: cErr } = await supabase
        .from('conversations')
        .select('metadata, clinic_id')
        .eq('id', conversationId)
        .eq('clinic_id', clinicId)
        .single()
      if (cErr || !convData) {
        throw new Error(`collect_info: lookup failed: ${cErr?.message ?? 'not found'}`)
      }
      const conv = convData as ConvRow

      const metadata = (conv.metadata ?? {}) as Record<string, unknown>
      const collected = (metadata['collected_info'] as Record<string, string> | undefined) ?? {}
      const nextMetadata = {
        ...metadata,
        collected_info: { ...collected, [field]: new Date().toISOString() },
      }

      const { error: uErr } = await supabase
        .from('conversations')
        .update({ metadata: nextMetadata })
        .eq('id', conversationId)
        .eq('clinic_id', clinicId)
      if (uErr) throw new Error(`collect_info: update failed: ${uErr.message}`)

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

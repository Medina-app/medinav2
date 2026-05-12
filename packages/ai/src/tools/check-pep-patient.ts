import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'

const InputSchema = z.object({
  phone: z
    .string()
    .regex(/^\+?\d{10,15}$/)
    .describe('Telefone do paciente em formato E.164 ou nacional (10-15 dígitos).'),
})

/**
 * M1a-2: read-only lookup PEP por telefone. Consulta `ansClient.lookupPatientByPhone`
 * (single roundtrip ao ANS). Quando paciente existe, retorna `exists:true` com
 * id + nome — agente cumprimenta pelo nome. Quando não existe, retorna
 * `exists:false` — agente sugere cadastro humano (escalação).
 *
 * Sem audit log (pure read; volume alto). Tool faz return estruturado
 * (não throw) quando ansClient ausente — alinhado com pattern Cal.com.
 */
export function buildCheckPepPatientTool(ctx: ToolContext) {
  return createTool({
    id: 'check_pep_patient',
    description:
      'Verifica se um telefone tem cadastro no PEP da clínica. Retorna nome+id do paciente quando achado, ou flag indicando que precisa cadastrar (escalação humana).',
    inputSchema: InputSchema,
    execute: async (inputData) => {
      const { phone } = inputData as z.infer<typeof InputSchema>
      const { ansClient } = ctx

      if (!ansClient) {
        return {
          ok: false as const,
          error: 'pep_ans_not_configured' as const,
          message:
            'Integração PEP ANS não configurada nesta clínica. Escala pra atendente humano.',
        }
      }

      const patient = await ansClient.lookupPatientByPhone(phone)
      if (patient == null) {
        return {
          ok: true as const,
          exists: false as const,
          message:
            'Paciente não cadastrado no PEP. Sugira cadastro com atendente humano antes de prosseguir.',
        }
      }

      return {
        ok: true as const,
        exists: true as const,
        patientId: patient.id,
        fullName: patient.fullName,
      }
    },
  })
}

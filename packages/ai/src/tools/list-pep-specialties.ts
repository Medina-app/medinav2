import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'

/**
 * M1a-2: lista especialidades PEP disponíveis pra esta clínica (catalog
 * local em pep_specialties). NÃO consulta ANS — catalog é seedado via
 * seed-pep-catalog.ts.
 *
 * Filtro: clinic_id = ctx.clinicId AND active = true. Cross-tenant safe
 * por design (eq clinic_id) — sem precisar ansClient.
 *
 * Usar quando paciente pergunta "quais especialidades atendem?" ou agente
 * precisa apresentar opções pra coleta de info.
 */
export function buildListPepSpecialtiesTool(ctx: ToolContext) {
  return createTool({
    id: 'list_pep_specialties',
    description:
      'Lista todas as especialidades disponíveis no PEP desta clínica. Use pra apresentar opções ao paciente ou validar especialidade mencionada antes de check_pep_availability.',
    inputSchema: z.object({}),
    execute: async () => {
      const { supabase, clinicId } = ctx
      const { data, error } = await supabase
        .from('pep_specialties')
        .select('id, ans_id, name')
        .eq('clinic_id', clinicId)
        .eq('active', true)
        .order('name', { ascending: true })

      if (error) {
        throw new Error(`list_pep_specialties: lookup failed: ${error.message}`)
      }

      const rows = (data ?? []) as Array<{ id: string; ans_id: string; name: string }>
      return {
        ok: true as const,
        specialties: rows.map((r) => ({ id: r.id, ansId: r.ans_id, name: r.name })),
        total: rows.length,
      }
    },
  })
}

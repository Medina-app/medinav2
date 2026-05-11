import type { FactCategory, PatientFact } from './types.js'

/** Display labels em pt-BR pra cada categoria — usado no header da seção. */
const CATEGORY_LABELS: Readonly<Record<FactCategory, string>> = {
  administrative: 'Administrativo',
  financial: 'Financeiro',
}

/** Ordem fixa de categorias no output (determinístico, independe da ordem
 *  que vem do DB). Caller usa todas; renderer omite seções vazias. */
const CATEGORY_ORDER: ReadonlyArray<FactCategory> = ['administrative', 'financial']

/**
 * Renderiza facts como bloco de contexto delimitado pra injeção no system
 * prompt do agente. Estrutura:
 *
 * <patient_memory>
 * ## Administrativo
 * - preferred_name: Jô
 * - profession: engenheiro
 *
 * ## Financeiro
 * - health_plan_name: Unimed
 * </patient_memory>
 *
 * Vazio quando facts é []. Escapa `</patient_memory>` no value pra evitar
 * que paciente feche a tag e injete instruções no prompt.
 */
export function buildPatientFactsContext(facts: ReadonlyArray<PatientFact>): string {
  if (facts.length === 0) return ''

  const byCategory = new Map<FactCategory, PatientFact[]>()
  for (const cat of CATEGORY_ORDER) {
    byCategory.set(cat, [])
  }
  for (const fact of facts) {
    const list = byCategory.get(fact.category)
    if (list) list.push(fact)
  }

  const lines: string[] = ['<patient_memory>']
  for (const cat of CATEGORY_ORDER) {
    const items = byCategory.get(cat) ?? []
    if (items.length === 0) continue
    items.sort((a, b) => a.key.localeCompare(b.key))
    lines.push(`## ${CATEGORY_LABELS[cat]}`)
    for (const fact of items) {
      lines.push(`- ${fact.key}: ${escapeValue(fact.value)}`)
    }
    lines.push('')
  }
  lines.push('</patient_memory>')
  return lines.join('\n')
}

/** Replace tag-like sequences no value que poderiam re-abrir o delimitador
 *  ou injetar pseudo-tags reconhecidas pelo agent. */
function escapeValue(value: string): string {
  return value.replace(/<\/?patient_memory>/gi, '[redacted]')
}

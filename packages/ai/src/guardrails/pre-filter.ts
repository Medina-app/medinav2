/**
 * AI-5 — Pre-filter (camada 1).
 *
 * Aplicado em cada mensagem inbound ANTES do LLM ser chamado. Se matchear
 * algum pattern de DEFAULT_BLOCKED_PATTERNS (ou override da clínica),
 * dispatcher pula direto pra escalate_conversation_with_reason +
 * canned response — LLM nem é invocado.
 *
 * Custo: ~regex linear nos patterns. Em prod com defaults atuais: < 1ms por
 * mensagem (3 categorias × ~4 patterns).
 *
 * NÃO é a única defesa: post-filter cobre output do LLM, urgency-detector
 * roda em paralelo com este pra risco vital. Pre-filter = "secretária não
 * fala disso, ponto" (medicação, diagnóstico, conduta clínica).
 */

import { mergeGuardrails } from './defaults.js'
import type { EscalatedReason, GuardrailsConfig, PreFilterMatch } from './types.js'

/**
 * Mapeia categoria de pattern → EscalatedReason persistido em
 * conversations.escalated_reason. Categorias custom (não-default) caem pra
 * 'other' — clínica que adiciona pattern fica responsável por escolher
 * categoria semântica via additional_blocked_patterns key, mas o reason
 * final é 'other' por design (esquema fechado em 5 valores no DB CHECK).
 */
const CATEGORY_TO_REASON: Record<string, EscalatedReason> = {
  medication_request: 'medication',
  diagnosis_request: 'diagnosis',
  diagnostic_advice: 'diagnosis',
  symptom_interpretation: 'symptom',
}

/**
 * Aplica patterns blocked (defaults + clinic override) na mensagem.
 * Primeiro match vence — ordem é determinística (Object.entries() segue
 * insertion order pra string keys, garantida pelo ECMAScript spec).
 */
export function preFilterMessage(
  content: string,
  config: GuardrailsConfig,
): PreFilterMatch {
  const { blocked } = mergeGuardrails(config)
  for (const [category, patterns] of Object.entries(blocked)) {
    for (const re of patterns) {
      const m = content.match(re)
      if (m) {
        return {
          matched: true,
          category,
          reason: CATEGORY_TO_REASON[category] ?? 'other',
          evidence: m[0],
        }
      }
    }
  }
  return { matched: false }
}

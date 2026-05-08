/**
 * AI-5 — Post-filter (camada 3, depois do LLM gerar texto).
 *
 * Aplica os MESMOS blocked patterns (defaults + clinic override) sobre o
 * output do LLM. Razão: defaults agora cobrem AMBOS os formatos:
 *   - User-shape (interrogativo): "qual remédio devo tomar?"
 *   - LLM-shape (declarativo): "você pode tomar paracetamol"
 *
 * Caller (dispatcher) decide o que fazer em violation:
 *   1. Tentar regenerar com correção (até 2x).
 *   2. Se persistir → escalate_conversation_with_reason + canned response.
 *
 * Esta função é PURA. Chamar com o texto do LLM e o GuardrailsConfig do
 * agent_config; mesmo merge contract do pre-filter (immutável + opt-out
 * de categoria opera em ambos blocked + urgent, mas urgent não se aplica
 * a output do LLM — quem fala em urgência é paciente, não secretária).
 */

import { mergeGuardrails } from './defaults.js'
import type { GuardrailsConfig, OutputValidation } from './types.js'

export function validateOutput(
  text: string,
  config: GuardrailsConfig,
): OutputValidation {
  const { blocked } = mergeGuardrails(config)
  for (const [category, patterns] of Object.entries(blocked)) {
    for (const re of patterns) {
      const m = text.match(re)
      if (m) {
        return { valid: false, violation: { category, evidence: m[0] } }
      }
    }
  }
  return { valid: true }
}

/**
 * AI-5 — Urgency detector (camada 2, paralela ao pre-filter).
 *
 * Híbrido em 2 níveis:
 *   1. Regex sobre DEFAULT_URGENT_PATTERNS + override da clínica (cobre 90%
 *      dos casos críticos óbvios). Custo: ~ms.
 *   2. LLM Haiku (OpenRouter) só quando regex inconclusiva (10% restantes —
 *      eufemismos, mensagens fragmentadas). Timeout default 3s; falha/timeout
 *      → fallback level='medium' (não bloqueia dispatch, mas eleva atenção
 *      em audit_logs).
 *
 * Esta função é PURA (sem side effects DB/network); o caller (dispatcher)
 * passa llmClassify quando quiser ativar a camada 2 e é responsável por
 * cabear a chamada real (haiku-classifier.ts).
 *
 * Critical NUNCA cai pra LLM — primeiro hit regex retorna direto.
 */

import { mergeGuardrails } from './defaults.js'
import type { GuardrailsConfig, UrgencyResult } from './types.js'

export type LlmClassify = (content: string) => Promise<{
  level: 'low' | 'medium' | 'critical'
  category?: string
}>

export interface UrgencyOpts {
  config: GuardrailsConfig
  /** Default false em test (evita chamada acidental). True em prod via env. */
  llmFallbackEnabled?: boolean
  /** Injectável pra test; em prod, dispatcher passa wrapper de Haiku. */
  llmClassify?: LlmClassify
  /** Default 3000ms — fonte: empírica, Haiku 4.5 responde 0.5-1.5s 95p; 3s
   *  cobre tail latency sem travar dispatch. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 3000

/**
 * Classifica urgência do conteúdo de uma mensagem inbound.
 *
 * Retorno:
 *   { level: 'critical', category, evidence, source: 'regex' } — hit em
 *     pattern (defaults ou clinic override). Usado pra escalation imediata
 *     com canned response (CVV 188 em suicide, etc).
 *   { level: 'critical'|'medium'|'low', source: 'llm' } — Haiku classificou.
 *   { level: 'medium', source: 'fallback' } — Haiku timeout/erro. Não
 *     escala, mas o dispatcher pode usar pra elevar prioridade no inbox.
 *   { level: 'low', source: 'regex' } — regex inconclusivo + LLM off.
 */
export async function detectUrgency(
  content: string,
  opts: UrgencyOpts,
): Promise<UrgencyResult> {
  const { urgent } = mergeGuardrails(opts.config)

  // Camada 1: regex.
  for (const [category, patterns] of Object.entries(urgent)) {
    for (const re of patterns) {
      const m = content.match(re)
      if (m) {
        return {
          level: 'critical',
          category,
          evidence: m[0],
          source: 'regex',
        }
      }
    }
  }

  // Camada 2: LLM Haiku fallback (opt-in).
  if (!opts.llmFallbackEnabled || !opts.llmClassify) {
    return { level: 'low', source: 'regex' }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    const verdict = await Promise.race([
      opts.llmClassify(content),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('haiku-timeout')), timeoutMs),
      ),
    ])
    return {
      level: verdict.level,
      ...(verdict.category != null ? { category: verdict.category } : {}),
      source: 'llm',
    }
  } catch {
    // Timeout ou erro de rede — fallback medium (não bloqueia paciente, mas
    // sinaliza pro audit que a defesa de camada 2 não confirmou.).
    return { level: 'medium', source: 'fallback' }
  }
}

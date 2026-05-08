/**
 * AI-5 — sanitização de `evidence` antes de propagar pra logs / Langfuse spans
 * / audit_logs.
 *
 * O match raw (m[0]) de pre-filter / urgency-detector / post-filter pode
 * conter dado clínico ou PII (nome, telefone, CPF parcial, sintoma específico).
 * Esses valores acabam em:
 *   - audit_logs.metadata (Postgres, retido indefinidamente)
 *   - Langfuse spans (inbound da observability platform)
 *   - Logs de aplicação (Vercel, Inngest)
 *
 * Mitigação (CodeRabbit Major):
 *   - Truncar 80 chars: o suficiente pra debug humano, evita capturar
 *     contexto longo que poderia conter mais PII.
 *   - Mascarar dígitos com `#`: telefone, CPF, datas, dosagens viram `###`.
 *     Caracteres não-digitais (texto da pergunta) são preservados.
 *
 * Não substitui anonimização full — é defesa em profundidade. PII estruturada
 * (nome, CPF) deve ter retention policy separada via LGPD.
 */
const MAX_EVIDENCE_LEN = 80

export function sanitizeEvidence(raw: string): string {
  return raw.slice(0, MAX_EVIDENCE_LEN).replace(/\d/g, '#')
}

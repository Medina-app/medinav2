/**
 * AI-3.5b: chunking helpers compartilhados entre worker process-kb-document
 * (Inngest) e seed-kb script (dev). Single source of truth pra paragrafação +
 * sentence boundary handling.
 *
 * Originalmente em packages/db/scripts/seed-kb.ts (PR #16); movido pra cá em
 * AI-3.5b pra reuso pelo worker production. seed-kb continua usando estes
 * helpers via @medina/ai.
 */

export const CHUNK_CHAR_LIMIT = 500;

/**
 * Splits markdown by blank-line paragraphs. Paragraphs longer than
 * CHUNK_CHAR_LIMIT are split on sentence boundaries. A paragraph that's still
 * longer than the limit (rare — single very long sentence) is kept as a
 * single chunk to avoid mid-sentence cuts that break embedding quality.
 */
export function chunkMarkdown(content: string): string[] {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= CHUNK_CHAR_LIMIT) {
      chunks.push(p);
      continue;
    }
    // CR fix #5: alternativa `|[^.!?]+$` captura tail sem pontuação final
    // (parágrafo solto sem ponto). Sem isso, último segmento era ignorado
    // quando o texto não termina em .!?.
    const sentences = p.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [p];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > CHUNK_CHAR_LIMIT && buf.length > 0) {
        chunks.push(buf.trim());
        buf = s;
      } else {
        buf += s;
      }
    }
    if (buf.trim().length > 0) chunks.push(buf.trim());
  }
  return chunks;
}

/** Approximate token count via a 4-chars-per-token heuristic. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

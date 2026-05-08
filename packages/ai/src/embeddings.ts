import OpenAI from 'openai'

let client: OpenAI | null = null

/** Issue #19: SDK default timeout é 10min — risco de tool call (search_kb)
 *  ficar pendurado e resposta WhatsApp atrasar.
 *
 *  CR review #1: openai-node v6 aplica `timeout` POR TENTATIVA + `maxRetries=N`
 *  significa N retries ALEM da inicial (1 + N tentativas total). Pior caso de
 *  budget: (maxRetries + 1) * timeout. Pra cabe num dispatch típico (search_kb
 *  é inline na resposta ao paciente, latência percebida importa), mantemos:
 *    (2 + 1) * 15_000ms = 45s pior caso
 *  Confortável dentro de qualquer SLA de WhatsApp/Inngest típico.
 *  Caso normal: ~500ms-1s, retries só em transient errors (5xx, rate limit). */
const OPENAI_TIMEOUT_MS = 15_000
const OPENAI_MAX_RETRIES = 2

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env['OPENAI_API_KEY'],
      timeout: OPENAI_TIMEOUT_MS,
      maxRetries: OPENAI_MAX_RETRIES,
    })
  }
  return client
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await getClient().embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  })
  const first = response.data[0]
  if (!first) {
    throw new Error('OpenAI embeddings returned empty data array')
  }
  return first.embedding
}

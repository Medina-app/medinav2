import OpenAI from 'openai'

let client: OpenAI | null = null

/** Issue #19: SDK default timeout é 10min — risco de tool call (search_kb)
 *  ficar pendurado e resposta WhatsApp atrasar. Inngest workflow timeout
 *  corta em 60s então 30s + 2 retries cabem com headroom. */
const OPENAI_TIMEOUT_MS = 30_000
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

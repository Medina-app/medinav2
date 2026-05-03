import OpenAI from 'openai'

let client: OpenAI | null = null

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] })
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

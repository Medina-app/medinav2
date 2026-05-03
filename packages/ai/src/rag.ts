import type { SupabaseClient } from '@supabase/supabase-js'
import { generateEmbedding } from './embeddings.js'
import type { RetrievedChunk } from './types.js'

export interface RetrieveKnowledgeOpts {
  clinicId: string
  query: string
  supabase: SupabaseClient
  documentIds?: string[]
  topK?: number
  similarityThreshold?: number
}

interface RpcRow {
  chunk_id: string
  document_id: string
  content: string
  similarity: number
}

export async function retrieveKnowledge(
  opts: RetrieveKnowledgeOpts
): Promise<RetrievedChunk[]> {
  const {
    clinicId,
    query,
    supabase,
    documentIds,
    topK = 5,
    similarityThreshold = 0.0,
  } = opts

  const embedding = await generateEmbedding(query)

  const { data, error } = await supabase.rpc('search_knowledge_chunks', {
    target_clinic_id: clinicId,
    query_embedding: embedding,
    top_k: topK,
    document_filter: documentIds ?? null,
  })

  if (error != null) {
    throw new Error((error as { message: string }).message)
  }

  const rows = (data ?? []) as RpcRow[]

  return rows
    .filter((r) => r.similarity >= similarityThreshold)
    .map((r) => ({
      id: r.chunk_id,
      documentId: r.document_id,
      content: r.content,
      similarity: r.similarity,
    }))
}

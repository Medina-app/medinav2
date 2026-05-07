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

  // Calls the service_role-only variant (migration 0017). The user-facing
  // `search_knowledge_chunks` enforces is_clinic_member(), which fails under
  // service_role because auth.uid() is NULL inside the Inngest worker — the
  // dispatcher already validates conversation.clinic_id cross-tenant, so we
  // pass the validated clinic_id and the function trusts it.
  const { data, error } = await supabase.rpc('search_knowledge_chunks_internal', {
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

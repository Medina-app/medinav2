import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'
import { retrieveKnowledge } from '../rag.js'

const InputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Pergunta do paciente para buscar na base de conhecimento da clínica. Use a frase original sempre que possível — embeddings são robustos a variações.',
    ),
})

const TOP_K = 3
const SIMILARITY_THRESHOLD = 0.7

export function buildSearchKbTool(ctx: ToolContext) {
  return createTool({
    id: 'search_kb',
    description:
      'Busca informações reais da clínica (horários, valores, especialidades, convênios, FAQ) na base de conhecimento. Use SEMPRE antes de responder sobre dados da clínica — NUNCA invente. Retorna { found, snippets: [{content, source, similarity}] }. Se found=false, peça mais detalhes ou escale.',
    inputSchema: InputSchema,
    execute: async (inputData) => {
      const { query } = inputData as z.infer<typeof InputSchema>
      const { supabase, clinicId, conversationId, knowledgeDocumentIds } = ctx

      // Empty array means "all documents" (matches RPC `document_filter = null`).
      const docIds =
        knowledgeDocumentIds && knowledgeDocumentIds.length > 0
          ? Array.from(knowledgeDocumentIds)
          : undefined

      const chunks = await retrieveKnowledge({
        clinicId,
        query,
        supabase,
        documentIds: docIds,
        topK: TOP_K,
        similarityThreshold: SIMILARITY_THRESHOLD,
      })

      if (chunks.length === 0) {
        await supabase.from('audit_logs').insert({
          clinic_id: clinicId,
          user_id: null,
          action: 'agent.tool.search_kb',
          resource: 'conversations',
          resource_id: conversationId,
          metadata: {
            query,
            top_k: TOP_K,
            threshold: SIMILARITY_THRESHOLD,
            found_count: 0,
            top_similarity: 0,
          },
        })
        return { found: false as const, snippets: [] as const }
      }

      // Batch-fetch titles. Belt-and-suspenders: filter by clinic_id even though
      // the chunks already came from a clinic-scoped RPC.
      const uniqueDocIds = Array.from(new Set(chunks.map((c) => c.documentId)))
      const { data: docs, error: dErr } = await supabase
        .from('knowledge_documents')
        .select('id, title')
        .eq('clinic_id', clinicId)
        .in('id', uniqueDocIds)
      if (dErr) {
        throw new Error(`search_kb: doc title fetch failed: ${(dErr as { message: string }).message}`)
      }
      const titleById = new Map(
        ((docs ?? []) as Array<{ id: string; title: string }>).map((d) => [d.id, d.title]),
      )

      const snippets = chunks.map((c) => ({
        content: c.content,
        source: titleById.get(c.documentId) ?? 'desconhecido',
        similarity: c.similarity,
      }))

      const topSimilarity = chunks[0]?.similarity ?? 0
      await supabase.from('audit_logs').insert({
        clinic_id: clinicId,
        user_id: null,
        action: 'agent.tool.search_kb',
        resource: 'conversations',
        resource_id: conversationId,
        metadata: {
          query,
          top_k: TOP_K,
          threshold: SIMILARITY_THRESHOLD,
          found_count: chunks.length,
          top_similarity: topSimilarity,
        },
      })

      return { found: true as const, snippets }
    },
  })
}

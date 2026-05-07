import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildMockSupabase, buildToolContext } from './_helpers.js'

vi.mock('../../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
}))

type Snippet = { content: string; source: string; similarity: number }
type ExecResult =
  | { found: true; snippets: Snippet[] }
  | { found: false; snippets: readonly never[] }

interface ToolWithExecute {
  execute: (input: { query: string }) => Promise<ExecResult>
  inputSchema: { safeParse: (v: unknown) => { success: boolean } }
}

function asTool(t: unknown): ToolWithExecute {
  return t as ToolWithExecute
}

const SAMPLE_ROWS = [
  { chunk_id: 'c1', document_id: 'd1', content: 'Cardio R$ 350,00', similarity: 0.92, metadata: {} },
  { chunk_id: 'c2', document_id: 'd1', content: 'Eletrocardiograma R$ 90,00', similarity: 0.85, metadata: {} },
  { chunk_id: 'c3', document_id: 'd2', content: 'FAQ agendamento', similarity: 0.72, metadata: {} },
  { chunk_id: 'c4', document_id: 'd2', content: 'low relevance', similarity: 0.35, metadata: {} },
]

const DOC_TITLES = [
  { id: 'd1', title: 'Procedimentos' },
  { id: 'd2', title: 'FAQ' },
]

beforeEach(() => {
  vi.clearAllMocks()
  // Default: every test starts with the embedding mock returning a 1536 vector.
  // Individual tests override (e.g. error case) via mockRejectedValueOnce.
})

describe('search_kb', () => {
  it('calls search_knowledge_chunks_internal with clinic_id from ctx, top_k=3, and generates embedding from the query', async () => {
    const { generateEmbedding } = await import('../../src/embeddings.js')
    const { buildSearchKbTool } = await import('../../src/tools/search-kb.js')
    const mock = buildMockSupabase({}, { data: [], error: null })
    const tool = asTool(
      buildSearchKbTool(buildToolContext({ supabase: mock.supabase as never, clinicId: 'clinic-A' })),
    )

    await tool.execute({ query: 'qual o horário?' })

    expect(generateEmbedding).toHaveBeenCalledWith('qual o horário?')
    expect(mock.rpc).toHaveBeenCalledWith(
      'search_knowledge_chunks_internal',
      expect.objectContaining({ target_clinic_id: 'clinic-A', top_k: 3 }),
    )
  })

  it('returns chunks above similarity threshold 0.4, dropping lower ones (rag.ts filter)', async () => {
    const { buildSearchKbTool } = await import('../../src/tools/search-kb.js')
    const mock = buildMockSupabase(
      { knowledge_documents: { inResult: DOC_TITLES } },
      { data: SAMPLE_ROWS, error: null },
    )
    const tool = asTool(buildSearchKbTool(buildToolContext({ supabase: mock.supabase as never })))

    const result = await tool.execute({ query: 'valor consulta' })

    if (!result.found) throw new Error('expected found=true')
    expect(result.snippets).toHaveLength(3)
    expect(result.snippets.every((s) => s.similarity >= 0.4)).toBe(true)
  })

  it('returns { found: false, snippets: [] } when RPC returns no chunks', async () => {
    const { buildSearchKbTool } = await import('../../src/tools/search-kb.js')
    const mock = buildMockSupabase({}, { data: [], error: null })
    const tool = asTool(buildSearchKbTool(buildToolContext({ supabase: mock.supabase as never })))

    const result = await tool.execute({ query: 'cirurgia espacial' })

    expect(result.found).toBe(false)
    expect(result.snippets).toEqual([])
  })

  it('returns { found: false } when all chunks are below threshold (e.g. KB miss with weak hits)', async () => {
    const { buildSearchKbTool } = await import('../../src/tools/search-kb.js')
    const weakRows = [{ chunk_id: 'c1', document_id: 'd1', content: 'x', similarity: 0.25, metadata: {} }]
    const mock = buildMockSupabase({}, { data: weakRows, error: null })
    const tool = asTool(buildSearchKbTool(buildToolContext({ supabase: mock.supabase as never })))

    const result = await tool.execute({ query: 'unrelated' })

    expect(result.found).toBe(false)
    expect(result.snippets).toEqual([])
  })

  it('passes knowledgeDocumentIds from ctx as document_filter in RPC', async () => {
    const { buildSearchKbTool } = await import('../../src/tools/search-kb.js')
    const mock = buildMockSupabase({}, { data: [], error: null })
    const tool = asTool(
      buildSearchKbTool(
        buildToolContext({
          supabase: mock.supabase as never,
          knowledgeDocumentIds: ['doc-x', 'doc-y'],
        }),
      ),
    )

    await tool.execute({ query: 'q' })

    expect(mock.rpc).toHaveBeenCalledWith(
      'search_knowledge_chunks_internal',
      expect.objectContaining({ document_filter: ['doc-x', 'doc-y'] }),
    )
  })

  it('passes null document_filter when knowledgeDocumentIds is empty array (means "all docs")', async () => {
    const { buildSearchKbTool } = await import('../../src/tools/search-kb.js')
    const mock = buildMockSupabase({}, { data: [], error: null })
    const tool = asTool(
      buildSearchKbTool(
        buildToolContext({ supabase: mock.supabase as never, knowledgeDocumentIds: [] }),
      ),
    )

    await tool.execute({ query: 'q' })

    expect(mock.rpc).toHaveBeenCalledWith(
      'search_knowledge_chunks_internal',
      expect.objectContaining({ document_filter: null }),
    )
  })

  it('throws and never calls RPC when embedding generation fails', async () => {
    const { generateEmbedding } = await import('../../src/embeddings.js')
    ;(generateEmbedding as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('OpenAI rate limit'),
    )
    const { buildSearchKbTool } = await import('../../src/tools/search-kb.js')
    const mock = buildMockSupabase({}, { data: [], error: null })
    const tool = asTool(buildSearchKbTool(buildToolContext({ supabase: mock.supabase as never })))

    await expect(tool.execute({ query: 'q' })).rejects.toThrow('OpenAI rate limit')
    expect(mock.rpc).not.toHaveBeenCalled()
  })

  it('formats snippets with document title (from knowledge_documents) as the source field', async () => {
    const { buildSearchKbTool } = await import('../../src/tools/search-kb.js')
    const mock = buildMockSupabase(
      { knowledge_documents: { inResult: DOC_TITLES } },
      { data: SAMPLE_ROWS.slice(0, 2), error: null },
    )
    const tool = asTool(buildSearchKbTool(buildToolContext({ supabase: mock.supabase as never })))

    const result = await tool.execute({ query: 'valor cardio' })

    if (!result.found) throw new Error('expected found=true')
    expect(result.snippets[0]?.source).toBe('Procedimentos')
    expect(result.snippets[0]?.content).toBe('Cardio R$ 350,00')
    expect(result.snippets[0]?.similarity).toBeCloseTo(0.92)
  })

  it('falls back to "desconhecido" source when document title lookup misses (defensive)', async () => {
    const { buildSearchKbTool } = await import('../../src/tools/search-kb.js')
    // Empty inResult — no titles found, e.g. doc was deleted between RPC and lookup
    const mock = buildMockSupabase(
      { knowledge_documents: { inResult: [] } },
      { data: [SAMPLE_ROWS[0]], error: null },
    )
    const tool = asTool(buildSearchKbTool(buildToolContext({ supabase: mock.supabase as never })))

    const result = await tool.execute({ query: 'q' })

    if (!result.found) throw new Error('expected found=true')
    expect(result.snippets[0]?.source).toBe('desconhecido')
  })

  it('writes audit_logs row with action=agent.tool.search_kb on hit (with metrics)', async () => {
    const { buildSearchKbTool } = await import('../../src/tools/search-kb.js')
    const mock = buildMockSupabase(
      { knowledge_documents: { inResult: DOC_TITLES } },
      { data: [SAMPLE_ROWS[0]], error: null },
    )
    const tool = asTool(
      buildSearchKbTool(
        buildToolContext({
          supabase: mock.supabase as never,
          clinicId: 'clinic-A',
          conversationId: 'conv-1',
        }),
      ),
    )

    await tool.execute({ query: 'qual valor cardio?' })

    const audit = mock.insertCalls.find((c) => c.table === 'audit_logs')
    expect(audit).toBeDefined()
    expect(audit!.payload).toMatchObject({
      clinic_id: 'clinic-A',
      user_id: null,
      action: 'agent.tool.search_kb',
      resource: 'conversations',
      resource_id: 'conv-1',
    })
    const meta = (audit!.payload as { metadata: Record<string, unknown> }).metadata
    expect(meta).toMatchObject({
      query: 'qual valor cardio?',
      top_k: 3,
      threshold: 0.4,
      found_count: 1,
    })
    expect(meta['top_similarity']).toBeCloseTo(0.92)
  })

  it('writes audit_logs row with found_count=0 on miss', async () => {
    const { buildSearchKbTool } = await import('../../src/tools/search-kb.js')
    const mock = buildMockSupabase({}, { data: [], error: null })
    const tool = asTool(buildSearchKbTool(buildToolContext({ supabase: mock.supabase as never })))

    await tool.execute({ query: 'unrelated' })

    const audit = mock.insertCalls.find((c) => c.table === 'audit_logs')
    expect(audit).toBeDefined()
    const meta = (audit!.payload as { metadata: Record<string, unknown> }).metadata
    expect(meta).toMatchObject({ query: 'unrelated', found_count: 0, top_similarity: 0 })
  })

  it('Zod rejects empty query and accepts non-empty', async () => {
    const { buildSearchKbTool } = await import('../../src/tools/search-kb.js')
    const tool = asTool(buildSearchKbTool(buildToolContext()))
    expect(tool.inputSchema.safeParse({ query: '' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ query: 'qual o horário?' }).success).toBe(true)
  })
})

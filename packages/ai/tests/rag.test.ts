import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
}))

const mockRpc = vi.fn()
const mockSupabase = { rpc: mockRpc } as unknown as SupabaseClient

const sampleRows = [
  {
    chunk_id: 'chunk-1',
    document_id: 'doc-1',
    content: 'First chunk content',
    similarity: 0.92,
    metadata: {},
  },
  {
    chunk_id: 'chunk-2',
    document_id: 'doc-1',
    content: 'Second chunk content',
    similarity: 0.75,
    metadata: {},
  },
]

describe('retrieveKnowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRpc.mockResolvedValue({ data: sampleRows, error: null })
  })

  it('calls search_knowledge_chunks with correct target_clinic_id', async () => {
    const { retrieveKnowledge } = await import('../src/rag.js')
    await retrieveKnowledge({
      clinicId: 'clinic-123',
      query: 'appointment schedule',
      supabase: mockSupabase,
    })
    expect(mockRpc).toHaveBeenCalledWith(
      'search_knowledge_chunks',
      expect.objectContaining({ target_clinic_id: 'clinic-123' })
    )
  })

  it('passes document_filter when documentIds provided', async () => {
    const { retrieveKnowledge } = await import('../src/rag.js')
    await retrieveKnowledge({
      clinicId: 'clinic-123',
      query: 'test',
      documentIds: ['doc-a', 'doc-b'],
      supabase: mockSupabase,
    })
    expect(mockRpc).toHaveBeenCalledWith(
      'search_knowledge_chunks',
      expect.objectContaining({ document_filter: ['doc-a', 'doc-b'] })
    )
  })

  it('passes null document_filter when documentIds not provided', async () => {
    const { retrieveKnowledge } = await import('../src/rag.js')
    await retrieveKnowledge({
      clinicId: 'clinic-123',
      query: 'test',
      supabase: mockSupabase,
    })
    expect(mockRpc).toHaveBeenCalledWith(
      'search_knowledge_chunks',
      expect.objectContaining({ document_filter: null })
    )
  })

  it('returns mapped RetrievedChunk array with correct fields', async () => {
    const { retrieveKnowledge } = await import('../src/rag.js')
    const result = await retrieveKnowledge({
      clinicId: 'clinic-123',
      query: 'test',
      supabase: mockSupabase,
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      id: 'chunk-1',
      documentId: 'doc-1',
      content: 'First chunk content',
      similarity: 0.92,
    })
  })

  it('filters out results below similarity threshold', async () => {
    const { retrieveKnowledge } = await import('../src/rag.js')
    const result = await retrieveKnowledge({
      clinicId: 'clinic-123',
      query: 'test',
      supabase: mockSupabase,
      similarityThreshold: 0.80,
    })
    expect(result).toHaveLength(1)
    const first = result[0]
    expect(first).toBeDefined()
    expect(first!.similarity).toBeGreaterThanOrEqual(0.80)
  })

  it('throws when supabase rpc returns an error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC failed' } })
    const { retrieveKnowledge } = await import('../src/rag.js')
    await expect(
      retrieveKnowledge({ clinicId: 'clinic-123', query: 'test', supabase: mockSupabase })
    ).rejects.toThrow('RPC failed')
  })

  it('returns empty array when RPC returns empty data', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null })
    const { retrieveKnowledge } = await import('../src/rag.js')
    const result = await retrieveKnowledge({
      clinicId: 'clinic-123',
      query: 'test',
      supabase: mockSupabase,
    })
    expect(result).toHaveLength(0)
  })
})

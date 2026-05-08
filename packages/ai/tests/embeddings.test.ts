import { describe, expect, it, vi, beforeEach } from 'vitest'

// Must mock before importing the module under test
vi.mock('openai', () => {
  const mockCreate = vi.fn()
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    embeddings: { create: mockCreate },
  }))
  // Attach mockCreate to MockOpenAI so tests can access it
  ;(MockOpenAI as unknown as Record<string, unknown>)['_mockCreate'] = mockCreate
  return { default: MockOpenAI }
})

describe('generateEmbedding', () => {
  let mockCreate: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    const { default: MockOpenAI } = await import('openai')
    mockCreate = (MockOpenAI as unknown as Record<string, unknown>)['_mockCreate'] as ReturnType<typeof vi.fn>
    mockCreate.mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }],
    })
  })

  it('returns a 1536-element number array', async () => {
    const { generateEmbedding } = await import('../src/embeddings.js')
    const result = await generateEmbedding('test query')
    expect(result).toHaveLength(1536)
    expect(typeof result[0]).toBe('number')
  })

  it('calls OpenAI with text-embedding-3-small model', async () => {
    const { generateEmbedding } = await import('../src/embeddings.js')
    await generateEmbedding('hello world')
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'text-embedding-3-small',
        input: 'hello world',
      })
    )
  })

  it('throws when OpenAI returns empty data array', async () => {
    mockCreate.mockResolvedValue({ data: [] })
    const { generateEmbedding } = await import('../src/embeddings.js')
    await expect(generateEmbedding('test')).rejects.toThrow(
      'OpenAI embeddings returned empty data'
    )
  })

  // Issue #19: SDK default timeout is 10min — risco de hangup do tool call.
  // Inngest dispatch corta antes (workflow timeout) mas resposta WhatsApp
  // ja vai ter atrasado.
  // CR review #1: openai-node v6 aplica timeout POR TENTATIVA;
  // pior caso = (maxRetries + 1) * timeout. Reduzido pra 15s + 2 retries
  // = 45s pior caso confortavel.
  it('constructs OpenAI client with timeout=15000 and maxRetries=2 (#19, CR-fix)', async () => {
    vi.resetModules() // garantir factory re-roda + closure mock fresca

    // CR review #1: re-importar mock pelo factory novo. mockCreate retornado
    // pelo factory eh o mesmo capturado pelo constructor closure. Mutar via
    // .mockResolvedValue afeta a behavior da closure — reassignar uma nova
    // vi.fn() em _mockCreate seria dead code (closure mantem ref antiga).
    const { default: MockOpenAI } = await import('openai')
    const closureMock = (MockOpenAI as unknown as Record<string, unknown>)['_mockCreate'] as ReturnType<typeof vi.fn>
    closureMock.mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }],
    })

    const { generateEmbedding } = await import('../src/embeddings.js')
    await generateEmbedding('warm up call to instantiate client')

    const ctorCalls = (MockOpenAI as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(ctorCalls.length).toBeGreaterThan(0)
    const firstCallArgs = ctorCalls[0]?.[0] as { apiKey?: string; timeout?: number; maxRetries?: number }
    expect(firstCallArgs).toMatchObject({
      timeout: 15_000,
      maxRetries: 2,
    })
  })
})

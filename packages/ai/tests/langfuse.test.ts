import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the langfuse SDK before any module under test imports it. The mock
// captures construction arguments and lets each test inject behavior.
const mockLangfuseInstance = {
  trace: vi.fn(),
  flushAsync: vi.fn().mockResolvedValue(undefined),
}
const MockLangfuseCtor = vi.fn().mockImplementation(() => mockLangfuseInstance)
vi.mock('langfuse', () => ({ Langfuse: MockLangfuseCtor }))

describe('getLangfuseClient', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockLangfuseInstance.trace.mockReset()
    // Reset module-level singleton between tests so env changes take effect.
    vi.resetModules()
    delete process.env['LANGFUSE_PUBLIC_KEY']
    delete process.env['LANGFUSE_SECRET_KEY']
    delete process.env['LANGFUSE_HOST']
  })

  afterEach(() => {
    delete process.env['LANGFUSE_PUBLIC_KEY']
    delete process.env['LANGFUSE_SECRET_KEY']
    delete process.env['LANGFUSE_HOST']
  })

  it('returns null when LANGFUSE_PUBLIC_KEY is missing', async () => {
    process.env['LANGFUSE_SECRET_KEY'] = 'sk-test'
    const { getLangfuseClient } = await import('../src/langfuse.js')
    expect(getLangfuseClient()).toBeNull()
  })

  it('returns null when LANGFUSE_SECRET_KEY is missing', async () => {
    process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-test'
    const { getLangfuseClient } = await import('../src/langfuse.js')
    expect(getLangfuseClient()).toBeNull()
  })

  it('returns a Langfuse instance when both keys are set', async () => {
    process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-test'
    process.env['LANGFUSE_SECRET_KEY'] = 'sk-test'
    process.env['LANGFUSE_HOST'] = 'https://cloud.langfuse.com'
    const { getLangfuseClient } = await import('../src/langfuse.js')
    const client = getLangfuseClient()
    expect(client).not.toBeNull()
    expect(MockLangfuseCtor).toHaveBeenCalledWith({
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      baseUrl: 'https://cloud.langfuse.com',
    })
  })

  it('memoizes the client across calls', async () => {
    process.env['LANGFUSE_PUBLIC_KEY'] = 'pk-test'
    process.env['LANGFUSE_SECRET_KEY'] = 'sk-test'
    const { getLangfuseClient } = await import('../src/langfuse.js')
    getLangfuseClient()
    getLangfuseClient()
    getLangfuseClient()
    expect(MockLangfuseCtor).toHaveBeenCalledTimes(1)
  })
})

describe('withTrace failsafe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLangfuseInstance.trace.mockReset()
  })

  it('runs the inner fn and returns its value when client is null', async () => {
    const { withTrace } = await import('../src/langfuse.js')
    const result = await withTrace(null, { name: 't', sessionId: 's' }, async () => 'ok')
    expect(result).toBe('ok')
  })

  it('passes a trace object to fn when client is set', async () => {
    const fakeTrace = { id: 'trace-1', update: vi.fn() }
    mockLangfuseInstance.trace.mockReturnValue(fakeTrace)
    const { withTrace } = await import('../src/langfuse.js')
    let receivedTrace: unknown = null
    await withTrace(
      mockLangfuseInstance as never,
      { name: 'dispatch-agent', sessionId: 'conv:c-1' },
      async (trace) => {
        receivedTrace = trace
        return 'ok'
      },
    )
    expect(receivedTrace).toBe(fakeTrace)
  })

  it('swallows trace creation errors so caller still runs', async () => {
    mockLangfuseInstance.trace.mockImplementation(() => {
      throw new Error('langfuse offline')
    })
    const { withTrace } = await import('../src/langfuse.js')
    const result = await withTrace(
      mockLangfuseInstance as never,
      { name: 't', sessionId: 's' },
      async () => 'caller-ok',
    )
    expect(result).toBe('caller-ok')
  })

  it('still calls flushAsync after fn even if trace.update throws', async () => {
    const flakyTrace = {
      update: vi.fn().mockImplementation(() => {
        throw new Error('flaky')
      }),
    }
    mockLangfuseInstance.trace.mockReturnValue(flakyTrace)
    const { withTrace } = await import('../src/langfuse.js')
    await withTrace(mockLangfuseInstance as never, { name: 't', sessionId: 's' }, async () => 'ok')
    expect(mockLangfuseInstance.flushAsync).toHaveBeenCalled()
  })

  it('propagates errors thrown by the inner fn (Inngest must retry on real failures)', async () => {
    mockLangfuseInstance.trace.mockReturnValue({ update: vi.fn() })
    const { withTrace } = await import('../src/langfuse.js')
    await expect(
      withTrace(mockLangfuseInstance as never, { name: 't', sessionId: 's' }, async () => {
        throw new Error('llm timeout')
      }),
    ).rejects.toThrow('llm timeout')
  })
})

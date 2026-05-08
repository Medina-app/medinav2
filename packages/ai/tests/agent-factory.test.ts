import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AgentNotFoundError, NamespacingViolationError } from '../src/errors.js'

// Mock @mastra/core/agent Agent before any module imports
const MockAgent = vi.fn().mockImplementation((opts: unknown) => ({ _opts: opts }))
vi.mock('@mastra/core/agent', () => ({ Agent: MockAgent }))

// Mock OpenRouter provider — createOpenRouter returns a callable that maps
// model id → model instance. The factory itself is created per call inside
// resolveModel(); the test asserts what was passed to that callable.
const mockOpenrouterCallable = vi.fn().mockImplementation((modelId: string) => ({
  _provider: 'openrouter',
  _id: modelId,
}))
const mockCreateOpenRouter = vi.fn().mockReturnValue(mockOpenrouterCallable)
vi.mock('@openrouter/ai-sdk-provider', () => ({ createOpenRouter: mockCreateOpenRouter }))

// Helper: build a Supabase mock that returns a specific row or error
function makeSupabaseMock(row: Record<string, unknown> | null, error: { message: string } | null = null) {
  const single = vi.fn().mockResolvedValue({ data: row, error })
  const eqStatus = vi.fn().mockReturnValue({ single })
  const eqName = vi.fn().mockReturnValue({ eq: eqStatus })
  const eqClinic = vi.fn().mockReturnValue({ eq: eqName })
  const select = vi.fn().mockReturnValue({ eq: eqClinic })
  const from = vi.fn().mockReturnValue({ select })
  return { from } as unknown as import('@supabase/supabase-js').SupabaseClient
}

const baseRow = {
  id: 'config-1',
  clinic_id: 'clinic-abc',
  name: 'default',
  version: 1,
  status: 'published',
  system_prompt: 'You are a medical assistant.',
  model: 'claude-sonnet-4-6',
  temperature: '0.70',
  max_tokens: 1024,
  tools: [],
  guardrails: {},
  knowledge_document_ids: [],
}

describe('createAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env['OPENROUTER_API_KEY'] = 'test-key'
  })

  it('loads published agent_config for the given clinic', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock(baseRow)
    const result = await createAgent({ clinicId: 'clinic-abc', supabase })
    expect(result.config.clinicId).toBe('clinic-abc')
    expect(result.config.status).toBe('published')
  })

  it('throws AgentNotFoundError when no published config exists', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock(null, { message: 'No rows found' })
    await expect(
      createAgent({ clinicId: 'clinic-abc', supabase })
    ).rejects.toThrow(AgentNotFoundError)
  })

  it('throws NamespacingViolationError when config clinic_id mismatches requested clinicId', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const tampered = { ...baseRow, clinic_id: 'clinic-OTHER' }
    const supabase = makeSupabaseMock(tampered)
    await expect(
      createAgent({ clinicId: 'clinic-abc', supabase })
    ).rejects.toThrow(NamespacingViolationError)
  })

  it('routes any model id through OpenRouter (anthropic/* prefix)', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock({ ...baseRow, model: 'anthropic/claude-sonnet-4-5' })
    await createAgent({ clinicId: 'clinic-abc', supabase })
    expect(mockCreateOpenRouter).toHaveBeenCalledWith({ apiKey: 'test-key' })
    expect(mockOpenrouterCallable).toHaveBeenCalledWith('anthropic/claude-sonnet-4-5')
  })

  it('routes any model id through OpenRouter (openai/* prefix)', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock({ ...baseRow, model: 'openai/gpt-4o-mini' })
    await createAgent({ clinicId: 'clinic-abc', supabase })
    expect(mockOpenrouterCallable).toHaveBeenCalledWith('openai/gpt-4o-mini')
  })

  it('throws when OPENROUTER_API_KEY is missing', async () => {
    delete process.env['OPENROUTER_API_KEY']
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock({ ...baseRow })
    await expect(createAgent({ clinicId: 'clinic-abc', supabase })).rejects.toThrow(
      'OPENROUTER_API_KEY not set'
    )
  })

  it('returns config with parsed temperature as number', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock({ ...baseRow, temperature: '0.30', max_tokens: 512 })
    const result = await createAgent({ clinicId: 'clinic-abc', supabase })
    expect(result.config.temperature).toBe(0.3)
    expect(result.config.maxTokens).toBe(512)
  })

  it('passes system_prompt as agent instructions', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock({ ...baseRow, system_prompt: 'Be concise.' })
    await createAgent({ clinicId: 'clinic-abc', supabase })
    expect(MockAgent).toHaveBeenCalledWith(
      expect.objectContaining({ instructions: 'Be concise.' })
    )
  })

  it('uses custom agentName when provided', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock({ ...baseRow, name: 'triage' })
    const result = await createAgent({ clinicId: 'clinic-abc', agentName: 'triage', supabase })
    expect(result.config.name).toBe('triage')
  })

  it('defaults agentName to "agente-principal" when not provided (fix #8)', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const single = vi.fn().mockResolvedValue({ data: { ...baseRow, name: 'agente-principal' }, error: null })
    const eqStatus = vi.fn().mockReturnValue({ single })
    const eqName = vi.fn().mockReturnValue({ eq: eqStatus })
    const eqClinic = vi.fn().mockReturnValue({ eq: eqName })
    const select = vi.fn().mockReturnValue({ eq: eqClinic })
    const from = vi.fn().mockReturnValue({ select })
    const supabase = { from } as unknown as import('@supabase/supabase-js').SupabaseClient

    await createAgent({ clinicId: 'clinic-abc', supabase })

    // The 2nd .eq() call applies the name filter — verify it was 'agente-principal'.
    expect(eqName).toHaveBeenCalledWith('name', 'agente-principal')
  })

  it('passes tools record to Agent constructor when provided', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock(baseRow)
    const tools = { my_tool: { id: 'my_tool' } }
    await createAgent({ clinicId: 'clinic-abc', supabase, tools })
    expect(MockAgent).toHaveBeenCalledWith(expect.objectContaining({ tools }))
  })

  it('omits tools field on Agent when no tools passed', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock(baseRow)
    await createAgent({ clinicId: 'clinic-abc', supabase })
    const callArg = MockAgent.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(callArg).toBeDefined()
    expect('tools' in (callArg ?? {})).toBe(false)
  })

  // AI-5: guardrails is jsonb object (GuardrailsConfig), not string[].
  // Existing prod row has guardrails={}; rowToConfig must produce a valid
  // empty GuardrailsConfig that callers can read defensively.
  it('parses guardrails={} as empty GuardrailsConfig object', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock({ ...baseRow, guardrails: {} })
    const result = await createAgent({ clinicId: 'clinic-abc', supabase })
    expect(result.config.guardrails).toEqual({})
    expect(Array.isArray(result.config.guardrails)).toBe(false)
    // Optional fields are undefined on empty config — callers pass through merge
    // helper, no need to default.
    const g = result.config.guardrails as { disabled_default_categories?: unknown }
    expect(g.disabled_default_categories).toBeUndefined()
  })

  it('preserves guardrails fields when populated (overrides + opt-outs)', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const populated = {
      ...baseRow,
      guardrails: {
        additional_blocked_patterns: { custom_cat: ['\\bfoo\\b'] },
        disabled_default_categories: ['diagnostic_advice'],
      },
    }
    const supabase = makeSupabaseMock(populated)
    const result = await createAgent({ clinicId: 'clinic-abc', supabase })
    const g = result.config.guardrails as {
      additional_blocked_patterns?: Record<string, string[]>
      disabled_default_categories?: string[]
    }
    expect(g.additional_blocked_patterns?.['custom_cat']).toEqual(['\\bfoo\\b'])
    expect(g.disabled_default_categories).toEqual(['diagnostic_advice'])
  })

  it('coalesces guardrails=null to {} (defensive for legacy rows)', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock({ ...baseRow, guardrails: null })
    const result = await createAgent({ clinicId: 'clinic-abc', supabase })
    expect(result.config.guardrails).toEqual({})
  })
})

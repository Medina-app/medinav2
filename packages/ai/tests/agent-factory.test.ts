import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AgentNotFoundError, NamespacingViolationError } from '../src/errors.js'

// Mock @mastra/core/agent Agent before any module imports
const MockAgent = vi.fn().mockImplementation((opts: unknown) => ({ _opts: opts }))
vi.mock('@mastra/core/agent', () => ({ Agent: MockAgent }))

// Mock AI providers
const mockAnthropic = vi.fn().mockReturnValue({ _provider: 'anthropic', _id: '' })
vi.mock('@ai-sdk/anthropic', () => ({ anthropic: mockAnthropic }))

const mockOpenai = vi.fn().mockReturnValue({ _provider: 'openai', _id: '' })
vi.mock('@ai-sdk/openai', () => ({ openai: mockOpenai }))

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
  guardrails: [],
  knowledge_document_ids: [],
}

describe('createAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('uses anthropic provider for claude- prefixed model', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock({ ...baseRow, model: 'claude-sonnet-4-6' })
    await createAgent({ clinicId: 'clinic-abc', supabase })
    expect(mockAnthropic).toHaveBeenCalledWith('claude-sonnet-4-6')
  })

  it('uses openai provider for non-claude model strings', async () => {
    const { createAgent } = await import('../src/agent-factory.js')
    const supabase = makeSupabaseMock({ ...baseRow, model: 'gpt-4o-mini' })
    await createAgent({ clinicId: 'clinic-abc', supabase })
    expect(mockOpenai).toHaveBeenCalledWith('gpt-4o-mini')
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
})

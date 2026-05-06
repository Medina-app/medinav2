import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mocks set up BEFORE module under test imports ──────────────────────────

// Mock createAgent: returns a fake agent whose .generate(messages) is
// vi.fn() so each test can stub the response. Capture invocations to
// assert messages array, model id, etc.
const mockGenerate = vi.fn().mockResolvedValue({
  text: 'olá! como posso ajudar?',
  totalUsage: { inputTokens: 120, outputTokens: 18, totalTokens: 138 },
  finishReason: 'stop',
  steps: [],
  warnings: [],
  providerMetadata: {},
  request: {},
  reasoning: [],
  reasoningText: undefined,
  toolCalls: [],
  toolResults: [],
  sources: [],
  files: [],
  response: { id: 'gen-1' },
  usage: { inputTokens: 120, outputTokens: 18 },
  object: undefined,
  error: undefined,
  tripwire: undefined,
  traceId: undefined,
})
const mockCreateAgent = vi.fn().mockResolvedValue({
  agent: { generate: mockGenerate },
  config: {
    id: 'cfg-1',
    clinicId: 'clinic-A',
    name: 'agente-principal',
    version: 1,
    status: 'published',
    systemPrompt: 'You are an assistant.',
    model: 'anthropic/claude-sonnet-4-5',
    temperature: 0.7,
    maxTokens: 1024,
    tools: [],
    guardrails: [],
    knowledgeDocumentIds: [],
  },
})
vi.mock('../src/agent-factory.js', () => ({ createAgent: mockCreateAgent }))

// Mock langfuse — we test failsafe paths, not real telemetry.
const mockTrace = {
  id: 'trace-1',
  update: vi.fn(),
  generation: vi.fn().mockReturnValue({ end: vi.fn() }),
  score: vi.fn(),
}
const mockLangfuseClient = {
  trace: vi.fn().mockReturnValue(mockTrace),
  flushAsync: vi.fn().mockResolvedValue(undefined),
}
const mockGetClient = vi.fn().mockReturnValue(mockLangfuseClient)
vi.mock('../src/langfuse.js', async () => {
  // Keep the real withTrace + LangfuseTrace shape; only stub the singleton.
  const actual = await vi.importActual<typeof import('../src/langfuse.js')>('../src/langfuse.js')
  return { ...actual, getLangfuseClient: () => mockGetClient() }
})

// ─── Supabase mock builder ──────────────────────────────────────────────────

interface FakeRows {
  conversation?: {
    id: string
    state: string
    clinic_id: string
    patient_id: string | null
  } | null
  agentConfig?: {
    id: string
    system_prompt: string
    model: string
    temperature: string | number
    max_tokens: number
    name: string
    tools: string[]
  } | null
  history?: Array<{
    content: string | null
    sender_type: 'patient' | 'ai' | 'human' | 'system'
    direction: 'inbound' | 'outbound'
    created_at: string
  }>
  insertedMessageId?: string
}

function makeSupabase(rows: FakeRows = {}) {
  const conversationSingle = vi
    .fn()
    .mockResolvedValue({ data: rows.conversation ?? null, error: rows.conversation ? null : { message: 'not found' } })
  const conversationEqId = vi.fn().mockReturnValue({ single: conversationSingle })
  const conversationSelect = vi.fn().mockReturnValue({ eq: conversationEqId })

  const agentMaybeSingle = vi.fn().mockResolvedValue({ data: rows.agentConfig ?? null, error: null })
  const agentEqName = vi.fn().mockReturnValue({ maybeSingle: agentMaybeSingle })
  const agentEqStatus = vi.fn().mockReturnValue({ eq: agentEqName })
  const agentEqClinic = vi.fn().mockReturnValue({ eq: agentEqStatus })
  const agentSelect = vi.fn().mockReturnValue({ eq: agentEqClinic })

  const historyLimit = vi.fn().mockResolvedValue({ data: rows.history ?? [], error: null })
  const historyOrder = vi.fn().mockReturnValue({ limit: historyLimit })
  const historyEq = vi.fn().mockReturnValue({ order: historyOrder })
  const historySelect = vi.fn().mockReturnValue({ eq: historyEq })

  const insertSingle = vi.fn().mockResolvedValue({ data: { id: rows.insertedMessageId ?? 'msg-out-1' }, error: null })
  const insertSelect = vi.fn().mockReturnValue({ single: insertSingle })
  const insertedMessage = vi.fn().mockReturnValue({ select: insertSelect })

  // .insert() and .select() chain shapes: first `.from('messages').insert(row).select('id').single()`,
  // for history we use `.from('messages').select(...).eq(...).order(...).limit(...)`. Distinguish by
  // whether select gets a column list (history) vs is chained after insert.
  const messagesFromCall = vi.fn().mockImplementation(() => ({
    select: historySelect,
    insert: insertedMessage,
  }))

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'conversations') return { select: conversationSelect }
    if (table === 'agent_configs') return { select: agentSelect }
    if (table === 'messages') return messagesFromCall()
    throw new Error(`unmocked table: ${table}`)
  })

  return {
    sb: { from } as never,
    spies: {
      from,
      agentSelect,
      agentEqClinic,
      historySelect,
      historyOrder,
      insertedMessage,
      insertSingle,
    },
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  // Re-prime the agent generate response so per-test mockGenerate.mock... is clean.
  mockGenerate.mockResolvedValue({
    text: 'olá! como posso ajudar?',
    totalUsage: { inputTokens: 120, outputTokens: 18, totalTokens: 138 },
    finishReason: 'stop',
    steps: [],
    warnings: [],
    providerMetadata: {},
    request: {},
    reasoning: [],
    reasoningText: undefined,
    toolCalls: [],
    toolResults: [],
    sources: [],
    files: [],
    response: { id: 'gen-1' },
    usage: { inputTokens: 120, outputTokens: 18 },
    object: undefined,
    error: undefined,
    tripwire: undefined,
    traceId: undefined,
  } as never)
  mockGetClient.mockReturnValue(mockLangfuseClient)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('dispatchAgent', () => {
  const baseConv = { id: 'conv-1', state: 'ai_handling', clinic_id: 'clinic-A', patient_id: 'pat-1' }
  const baseCfg = {
    id: 'cfg-1',
    system_prompt: 'You are a clinic assistant.',
    model: 'anthropic/claude-sonnet-4-5',
    temperature: 0.7,
    max_tokens: 1024,
    name: 'agente-principal',
    tools: [],
  }

  it('throws AgentDispatchSkipped when conversation.state is waiting_human', async () => {
    const { sb } = makeSupabase({
      conversation: { ...baseConv, state: 'waiting_human' },
      agentConfig: baseCfg,
    })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    const { AgentDispatchSkipped } = await import('../src/errors.js')
    await expect(
      dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'msg-in-1', supabase: sb }),
    ).rejects.toBeInstanceOf(AgentDispatchSkipped)
  })

  it('throws AgentDispatchSkipped when conversation.state is resolved', async () => {
    const { sb } = makeSupabase({ conversation: { ...baseConv, state: 'resolved' }, agentConfig: baseCfg })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    const { AgentDispatchSkipped } = await import('../src/errors.js')
    await expect(
      dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'm', supabase: sb }),
    ).rejects.toBeInstanceOf(AgentDispatchSkipped)
  })

  it('throws AgentDispatchSkipped when no published agent_config exists', async () => {
    const { sb } = makeSupabase({ conversation: baseConv, agentConfig: null })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    const { AgentDispatchSkipped } = await import('../src/errors.js')
    await expect(
      dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'm', supabase: sb }),
    ).rejects.toBeInstanceOf(AgentDispatchSkipped)
  })

  it('cross-tenant: throws when conversation.clinic_id mismatches the request clinicId', async () => {
    const { sb } = makeSupabase({
      conversation: { ...baseConv, clinic_id: 'clinic-OTHER' },
      agentConfig: baseCfg,
    })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    await expect(
      dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'm', supabase: sb }),
    ).rejects.toThrow(/cross.tenant/i)
  })

  it('loads agent_config filtering by the requested clinic_id (cross-tenant safe)', async () => {
    const { sb, spies } = makeSupabase({ conversation: baseConv, agentConfig: baseCfg })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    await dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'm', supabase: sb })
    // The first .eq() call after .select() must be ('clinic_id', 'clinic-A').
    expect(spies.agentEqClinic).toHaveBeenCalledWith('clinic_id', 'clinic-A')
  })

  it('passes last 20 messages from conversation as context (oldest first via reverse)', async () => {
    const history = Array.from({ length: 25 }, (_, i) => ({
      content: `msg ${i}`,
      sender_type: (i % 2 === 0 ? 'patient' : 'ai') as 'patient' | 'ai',
      direction: (i % 2 === 0 ? 'inbound' : 'outbound') as 'inbound' | 'outbound',
      created_at: `2026-05-05T10:${String(i).padStart(2, '0')}:00Z`,
    }))
    const { sb, spies } = makeSupabase({ conversation: baseConv, agentConfig: baseCfg, history: history.slice(-20).reverse() })

    const { dispatchAgent } = await import('../src/dispatcher.js')
    await dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'm', supabase: sb })

    expect(spies.historyOrder).toHaveBeenCalledWith('created_at', { ascending: false })
    // 20-message limit
    const limitFn = spies.historyOrder.mock.results[0]?.value.limit
    expect(limitFn).toHaveBeenCalledWith(20)
    // Agent received messages with role=user|assistant
    const generateArgs = mockGenerate.mock.calls[0]?.[0]
    expect(generateArgs).toHaveLength(20)
    expect(generateArgs?.[0]?.role).toMatch(/user|assistant/)
  })

  it('inserts response with sender_type=ai, outbox_status=pending, agent_config_id, direction=outbound', async () => {
    const { sb, spies } = makeSupabase({ conversation: baseConv, agentConfig: baseCfg })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    const result = await dispatchAgent({
      conversationId: 'conv-1',
      clinicId: 'clinic-A',
      messageId: 'msg-in',
      supabase: sb,
    })

    expect(spies.insertedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        clinic_id: 'clinic-A',
        conversation_id: 'conv-1',
        direction: 'outbound',
        sender_type: 'ai',
        sender_user_id: null,
        content_type: 'text',
        content: 'olá! como posso ajudar?',
        external_id: null,
        delivery_status: 'pending',
        outbox_status: 'pending',
        agent_config_id: 'cfg-1',
      }),
    )
    expect(result.messageId).toBe('msg-out-1')
    expect(result.tokensIn).toBe(120)
    expect(result.tokensOut).toBe(18)
  })

  it('records langfuse trace with sessionId clinic:X:conv:Y and metadata', async () => {
    const { sb } = makeSupabase({ conversation: baseConv, agentConfig: baseCfg })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    await dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'msg-in', supabase: sb })

    expect(mockLangfuseClient.trace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'dispatch-agent',
        sessionId: 'clinic:clinic-A:conv:conv-1',
        metadata: expect.objectContaining({
          conversationId: 'conv-1',
          clinicId: 'clinic-A',
          model: 'anthropic/claude-sonnet-4-5',
          agentConfigId: 'cfg-1',
        }),
      }),
    )
  })

  it('continues even when langfuse client is null (failsafe)', async () => {
    mockGetClient.mockReturnValueOnce(null)
    const { sb } = makeSupabase({ conversation: baseConv, agentConfig: baseCfg })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    const result = await dispatchAgent({
      conversationId: 'conv-1',
      clinicId: 'clinic-A',
      messageId: 'm',
      supabase: sb,
    })
    expect(result.messageId).toBe('msg-out-1')
    expect(result.traceId).toBeNull()
  })

  it('propagates LLM errors so Inngest can retry', async () => {
    mockGenerate.mockRejectedValueOnce(new Error('rate limit'))
    const { sb } = makeSupabase({ conversation: baseConv, agentConfig: baseCfg })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    await expect(
      dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'm', supabase: sb }),
    ).rejects.toThrow('rate limit')
  })

  // ─── AI-2 additions ─────────────────────────────────────────────────────────

  it('passes temperature, maxOutputTokens, maxSteps to agent.generate (fix #7)', async () => {
    const { sb } = makeSupabase({
      conversation: baseConv,
      agentConfig: { ...baseCfg, temperature: 0.2, max_tokens: 100 },
    })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    await dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'm', supabase: sb })

    const opts = mockGenerate.mock.calls[0]?.[1]
    expect(opts).toMatchObject({
      maxSteps: 5,
      modelSettings: { temperature: 0.2, maxOutputTokens: 100 },
    })
  })

  it('parses temperature from PostgREST numeric (string → number) (fix #7 prod-shape)', async () => {
    // PostgREST serializes numeric(3,2) as a string ("0.30") to preserve
    // arbitrary precision. The dispatcher MUST coerce to number before passing
    // to AI-SDK modelSettings, otherwise the model silently uses its default.
    const { sb } = makeSupabase({
      conversation: baseConv,
      agentConfig: { ...baseCfg, temperature: '0.30' as unknown as number, max_tokens: 256 },
    })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    await dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'm', supabase: sb })

    const opts = mockGenerate.mock.calls[0]?.[1] as { modelSettings: { temperature: number } }
    expect(typeof opts.modelSettings.temperature).toBe('number')
    expect(opts.modelSettings.temperature).toBe(0.3)
  })

  it('passes tools built from agent_config.tools to createAgent', async () => {
    const { sb } = makeSupabase({
      conversation: baseConv,
      agentConfig: { ...baseCfg, tools: ['escalate_to_human', 'check_business_hours'] },
    })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    await dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'm', supabase: sb })

    const callArg = mockCreateAgent.mock.calls[0]?.[0] as { tools: Record<string, unknown> }
    expect(callArg.tools).toBeDefined()
    expect(Object.keys(callArg.tools).sort()).toEqual(['check_business_hours', 'escalate_to_human'])
  })

  it('skips outbound message insert when escalate_to_human was called and text is empty', async () => {
    mockGenerate.mockResolvedValueOnce({
      text: '',
      totalUsage: { inputTokens: 50, outputTokens: 5 },
      steps: [{ toolCalls: [{ payload: { toolName: 'escalate_to_human' } }] }],
      toolCalls: [{ payload: { toolName: 'escalate_to_human' } }],
    } as never)
    const { sb, spies } = makeSupabase({
      conversation: baseConv,
      agentConfig: { ...baseCfg, tools: ['escalate_to_human'] },
    })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    const result = await dispatchAgent({
      conversationId: 'conv-1',
      clinicId: 'clinic-A',
      messageId: 'm',
      supabase: sb,
    })

    // The insert chain (insert → select → single) is only walked when text is non-empty.
    expect(spies.insertedMessage).not.toHaveBeenCalled()
    expect(result.messageId).toBe('')
  })

  it('still inserts outbound goodbye text when escalate was called AND text is non-empty', async () => {
    mockGenerate.mockResolvedValueOnce({
      text: 'Tudo bem, vou te transferir agora. Até logo!',
      totalUsage: { inputTokens: 60, outputTokens: 12 },
      steps: [{ toolCalls: [{ payload: { toolName: 'escalate_to_human' } }] }],
      toolCalls: [{ payload: { toolName: 'escalate_to_human' } }],
    } as never)
    const { sb, spies } = makeSupabase({
      conversation: baseConv,
      agentConfig: { ...baseCfg, tools: ['escalate_to_human'] },
    })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    await dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'm', supabase: sb })

    expect(spies.insertedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Tudo bem, vou te transferir agora. Até logo!' }),
    )
  })

  it('accepts agentName arg, defaults to agente-principal', async () => {
    const { sb, spies } = makeSupabase({
      conversation: baseConv,
      agentConfig: { ...baseCfg, name: 'agente-triagem' },
    })
    const { dispatchAgent } = await import('../src/dispatcher.js')
    await dispatchAgent({
      conversationId: 'conv-1',
      clinicId: 'clinic-A',
      messageId: 'm',
      supabase: sb,
      agentName: 'agente-triagem',
    })

    // Verify the agent_configs query filtered by name='agente-triagem'.
    const eqStatusReturn = spies.agentEqClinic.mock.results[0]?.value
    const eqStatusCall = eqStatusReturn?.eq
    expect(eqStatusCall).toHaveBeenCalledWith('status', 'published')

    expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'agente-triagem' }))
  })
})

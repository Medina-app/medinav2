import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @medina/chat helpers BEFORE importing the adapter so it picks up the mocks.
vi.mock('@medina/chat', () => ({
  lookupOrCreatePatientByPhone: vi.fn(),
  getOrCreateConversation: vi.fn(),
  addMessage: vi.fn(),
  updateMessageDeliveryStatus: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}));

import { createClient } from '@supabase/supabase-js';
import {
  lookupOrCreatePatientByPhone,
  getOrCreateConversation,
  addMessage,
  updateMessageDeliveryStatus,
} from '@medina/chat';
import { kapsoAdapter } from '../src/adapter';

// Build a chainable mock Supabase client. The adapter calls:
//   - sb.from('clinic_integrations').update(...).eq(...)              (lazy phone_number_id capture)
//   - sb.from('agent_configs').select().eq().eq().eq().limit().maybeSingle()  (AI presence check;
//     three .eq calls: clinic_id, status='published', name='agente-principal')
// Routes by table name; default agent_configs response is null (no agent).
function buildMockSupabase(opts: { agentRow?: Record<string, unknown> | null } = {}) {
  const updateEq = vi.fn().mockResolvedValue({ data: null, error: null });
  const integrationsChain = { update: vi.fn().mockReturnValue({ eq: updateEq }) };

  const agentMaybeSingle = vi.fn().mockResolvedValue({ data: opts.agentRow ?? null, error: null });
  const agentLimit = vi.fn().mockReturnValue({ maybeSingle: agentMaybeSingle });
  const agentEqName = vi.fn().mockReturnValue({ limit: agentLimit });
  const agentEqStatus = vi.fn().mockReturnValue({ eq: agentEqName });
  const agentEqClinic = vi.fn().mockReturnValue({ eq: agentEqStatus });
  const agentSelect = vi.fn().mockReturnValue({ eq: agentEqClinic });
  const agentChain = { select: agentSelect };

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'agent_configs') return agentChain;
    return integrationsChain;
  });
  return {
    client: { from } as unknown,
    fromMock: from,
    updateMock: integrationsChain.update,
    eqMock: updateEq,
    agentSelectMock: agentSelect,
    agentEqNameMock: agentEqName,
  };
}

const baseInbound = {
  message: {
    from: '5581987654321',
    id: 'wamid.IN-1',
    kapso: { direction: 'inbound', status: 'received', statuses: [] },
    text: { body: 'oi' },
    timestamp: '1777856191',
    type: 'text',
  },
  conversation: { id: 'conv-1', contact_name: 'Gabriel Arruda' },
  phone_number_id: '647015955153740',
};

const deliveredStatus = {
  message: {
    id: 'wamid.OUT-1',
    to: '5581987654321',
    type: 'text',
    timestamp: '1777856200',
    kapso: { direction: 'outbound', status: 'delivered', statuses: [] },
  },
  conversation: { id: 'conv-1' },
  phone_number_id: '647015955153740',
};

function buildCtx(
  payload: unknown,
  event: string,
  integration: Record<string, unknown> = {},
  overrides: {
    inngestSend?: ReturnType<typeof vi.fn> | null;
    publishEvent?: ReturnType<typeof vi.fn>;
  } = {},
): Parameters<typeof kapsoAdapter.handle>[0] {
  // CHAT-2: status path dispatches via ctx.inngestSend instead of calling
  // updateMessageDeliveryStatus inline. Default mock here so existing tests
  // exercising the inbound path stay unaffected; pass `inngestSend: null` to
  // exercise the missing-dispatch error path explicitly.
  const inngestSend = overrides.inngestSend === null
    ? undefined
    : overrides.inngestSend ?? vi.fn().mockResolvedValue(undefined);

  return {
    clinicId: 'clinic-1',
    integration: {
      id: 'integ-1',
      clinicId: 'clinic-1',
      type: 'whatsapp',
      provider: 'kapso',
      name: 'WA',
      status: 'active',
      config: {},
      ...integration,
    } as unknown as Parameters<typeof kapsoAdapter.handle>[0]['integration'],
    payload,
    headers: { 'x-webhook-event': event },
    rawBody: JSON.stringify(payload),
    inngestSend,
    publishEvent: overrides.publishEvent,
  };
}

beforeEach(() => {
  const { client } = buildMockSupabase();
  vi.mocked(createClient).mockReturnValue(client as ReturnType<typeof createClient>);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('kapsoAdapter contract', () => {
  it('signatureHeader is x-webhook-signature', () => {
    expect(kapsoAdapter.signatureHeader).toBe('x-webhook-signature');
  });
  it('type is whatsapp and provider is kapso', () => {
    expect(kapsoAdapter.type).toBe('whatsapp');
    expect(kapsoAdapter.provider).toBe('kapso');
  });
});

describe('kapsoAdapter.handle inbound message', () => {
  // Scenario 1: parses inbound text and persists conversation+message
  // Scenario 5: creates patient when phone unknown (via mock returning created=true)
  // Scenario 7: passes contact_name as nameHint
  it('inbound text → patient + conversation + message inserted, hint flowed', async () => {
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({
      patient: { id: 'pat-1' } as never,
      created: true,
    });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv-uuid' } as never,
      created: true,
    });
    vi.mocked(addMessage).mockResolvedValue({
      message: { id: 'msg-1' } as never,
      created: true,
    });

    const result = await kapsoAdapter.handle(buildCtx(baseInbound, 'whatsapp.message.received'));

    expect(result).toEqual({ processed: true, reason: 'message_inserted' });
    expect(lookupOrCreatePatientByPhone).toHaveBeenCalledWith(
      expect.anything(),
      'clinic-1',
      '+5581987654321',         // ← E.164 normalized
      'Gabriel Arruda',         // ← nameHint from conversation.contact_name
    );
    expect(getOrCreateConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clinicId: 'clinic-1',
        integrationId: 'integ-1',
        channel: 'whatsapp',
        externalId: '+5581987654321',
        patientId: 'pat-1',
      }),
    );
    expect(addMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clinicId: 'clinic-1',
        conversationId: 'conv-uuid',
        direction: 'inbound',
        senderType: 'patient',
        contentType: 'text',
        content: 'oi',
        externalId: 'wamid.IN-1',
        deliveryStatus: 'delivered',
      }),
    );
  });

  // Scenario 4: idempotency — same external_id processed twice = 1 message inserted
  it('returns reason=duplicate_idempotent when addMessage reports created=false', async () => {
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({ patient: { id: 'pat' } as never, created: false });
    vi.mocked(getOrCreateConversation).mockResolvedValue({ conversation: { id: 'conv' } as never, created: false });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: false });

    const result = await kapsoAdapter.handle(buildCtx(baseInbound, 'whatsapp.message.received'));
    expect(result.reason).toBe('duplicate_idempotent');
  });

  // Scenario 6: links message to existing patient by phone match (mock created=false)
  it('links to existing patient when lookup returns created=false', async () => {
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({
      patient: { id: 'existing-pat' } as never,
      created: false,
    });
    vi.mocked(getOrCreateConversation).mockResolvedValue({ conversation: { id: 'conv' } as never, created: false });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: true });

    await kapsoAdapter.handle(buildCtx(baseInbound, 'whatsapp.message.received'));

    expect(getOrCreateConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ patientId: 'existing-pat' }),
    );
  });

  it('publishes message.new to BOTH the conversation channel and the inbox channel after persistInbound succeeds', async () => {
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({
      patient: { id: 'pat-1' } as never,
      created: true,
    });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv-uuid' } as never,
      created: true,
    });
    vi.mocked(addMessage).mockResolvedValue({
      message: { id: 'msg-id-7' } as never,
      created: true,
    });

    const publishEvent = vi.fn();
    await kapsoAdapter.handle(
      buildCtx(baseInbound, 'whatsapp.message.received', {}, { publishEvent }),
    );

    const expectedPayload = {
      type: 'message.new',
      conversationId: 'conv-uuid',
      messageId: 'msg-id-7',
      clinicId: 'clinic-1',
    };
    expect(publishEvent).toHaveBeenCalledTimes(2);
    expect(publishEvent).toHaveBeenNthCalledWith(1, 'conv:conv-uuid', expectedPayload);
    expect(publishEvent).toHaveBeenNthCalledWith(2, 'inbox:clinic-1', expectedPayload);
  });

  it('swallows a synchronous publishEvent throw so webhook ACK is not blocked', async () => {
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({
      patient: { id: 'pat-1' } as never,
      created: true,
    });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv-uuid' } as never,
      created: true,
    });
    vi.mocked(addMessage).mockResolvedValue({
      message: { id: 'msg-id-9' } as never,
      created: true,
    });

    const publishEvent = vi.fn(() => {
      throw new Error('centrifugo url misconfigured');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await kapsoAdapter.handle(
      buildCtx(baseInbound, 'whatsapp.message.received', {}, { publishEvent }),
    );

    // Both channels attempted; both threw; both swallowed.
    expect(publishEvent).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ processed: true, reason: 'message_inserted' });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('does NOT publish when addMessage reports duplicate (idempotent retry)', async () => {
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({
      patient: { id: 'pat' } as never,
      created: false,
    });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv' } as never,
      created: false,
    });
    vi.mocked(addMessage).mockResolvedValue({
      message: { id: 'msg' } as never,
      created: false,
    });

    const publishEvent = vi.fn();
    await kapsoAdapter.handle(
      buildCtx(baseInbound, 'whatsapp.message.received', {}, { publishEvent }),
    );

    expect(publishEvent).not.toHaveBeenCalled();
  });

  // Scenario 2: unsupported types persist with placeholder content
  it('non-text type maps to placeholder content', async () => {
    const imagePayload = {
      ...baseInbound,
      message: { ...baseInbound.message, type: 'image', text: undefined },
    };
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({ patient: { id: 'pat' } as never, created: false });
    vi.mocked(getOrCreateConversation).mockResolvedValue({ conversation: { id: 'conv' } as never, created: false });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: true });

    await kapsoAdapter.handle(buildCtx(imagePayload, 'whatsapp.message.received'));

    expect(addMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contentType: 'image',
        content: '[Anexo não exibido — suporte em CHAT-4]',
      }),
    );
  });

  it('captures phone_number_id into integration.config when missing', async () => {
    const captured = buildMockSupabase();
    vi.mocked(createClient).mockReturnValue(captured.client as ReturnType<typeof createClient>);
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({ patient: { id: 'pat' } as never, created: false });
    vi.mocked(getOrCreateConversation).mockResolvedValue({ conversation: { id: 'conv' } as never, created: false });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: true });

    await kapsoAdapter.handle(buildCtx(baseInbound, 'whatsapp.message.received'));

    expect(captured.fromMock).toHaveBeenCalledWith('clinic_integrations');
    expect(captured.updateMock).toHaveBeenCalledWith({
      config: { phone_number_id: '647015955153740' },
    });
    expect(captured.eqMock).toHaveBeenCalledWith('id', 'integ-1');
  });

  it('does NOT update integration.config when phone_number_id already matches', async () => {
    const captured = buildMockSupabase();
    vi.mocked(createClient).mockReturnValue(captured.client as ReturnType<typeof createClient>);
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({ patient: { id: 'pat' } as never, created: false });
    vi.mocked(getOrCreateConversation).mockResolvedValue({ conversation: { id: 'conv' } as never, created: false });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: true });

    await kapsoAdapter.handle(
      buildCtx(baseInbound, 'whatsapp.message.received', {
        config: { phone_number_id: '647015955153740' },
      }),
    );

    expect(captured.fromMock).not.toHaveBeenCalledWith('clinic_integrations');
  });
});

describe('kapsoAdapter.handle status update (dispatch via Inngest)', () => {
  // CHAT-2: status webhook now fires an Inngest event instead of calling
  // updateMessageDeliveryStatus synchronously. The worker handles persistence
  // (with the terminal-state regression guard) on the other end.
  it('whatsapp.message.delivered → ctx.inngestSend dispatched, returns processed=true', async () => {
    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const result = await kapsoAdapter.handle(
      buildCtx(deliveredStatus, 'whatsapp.message.delivered', {}, { inngestSend }),
    );

    expect(result).toEqual({ processed: true, reason: 'status_dispatched' });
    expect(inngestSend).toHaveBeenCalledWith({
      name: 'chat/message.status_update',
      id: 'status:wamid.OUT-1:delivered',
      data: {
        clinicId: 'clinic-1',
        externalMessageId: 'wamid.OUT-1',
        status: 'delivered',
        deliveryError: undefined,
      },
    });
    // Adapter must NOT call the sync helper anymore.
    expect(updateMessageDeliveryStatus).not.toHaveBeenCalled();
  });

  it('throws explicit error when ctx.inngestSend is missing (no silent fallback)', async () => {
    await expect(
      kapsoAdapter.handle(
        buildCtx(deliveredStatus, 'whatsapp.message.delivered', {}, { inngestSend: null }),
      ),
    ).rejects.toThrow(/inngestSend not configured/);
  });

  it('wraps inngestSend failure as InngestDispatchError so caller can return 5xx', async () => {
    const inngestSend = vi.fn().mockRejectedValue(new Error('upstream down'));
    await expect(
      kapsoAdapter.handle(
        buildCtx(deliveredStatus, 'whatsapp.message.delivered', {}, { inngestSend }),
      ),
    ).rejects.toMatchObject({ name: 'InngestDispatchError' });
  });
});

describe('kapsoAdapter.handle unhandled events', () => {
  it('returns processed=false reason=unhandled_event for whatsapp.conversation.created', async () => {
    const result = await kapsoAdapter.handle(
      buildCtx({ conversation: { id: 'x' }, phone_number_id: 'y' }, 'whatsapp.conversation.created'),
    );
    expect(result).toEqual({ processed: false, reason: 'unhandled_event' });
  });

  it('returns processed=false when X-Webhook-Event header is missing', async () => {
    const result = await kapsoAdapter.handle(buildCtx(baseInbound, ''));
    expect(result.reason).toBe('unhandled_event');
  });
});

describe('kapsoAdapter.handle inbound: AI dispatch', () => {
  it('passes initialState=ai_handling to getOrCreateConversation when clinic has published agent', async () => {
    const captured = buildMockSupabase({ agentRow: { id: 'cfg-1' } });
    vi.mocked(createClient).mockReturnValue(captured.client as ReturnType<typeof createClient>);
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({
      patient: { id: 'pat-1' } as never,
      created: true,
    });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv-uuid', state: 'ai_handling' } as never,
      created: true,
    });
    vi.mocked(addMessage).mockResolvedValue({
      message: { id: 'msg-1' } as never,
      created: true,
    });

    await kapsoAdapter.handle(buildCtx(baseInbound, 'whatsapp.message.received'));

    expect(getOrCreateConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ initialState: 'ai_handling' }),
    );
  });

  it('passes initialState=waiting_human when clinic has NO published agent', async () => {
    const captured = buildMockSupabase({ agentRow: null });
    vi.mocked(createClient).mockReturnValue(captured.client as ReturnType<typeof createClient>);
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({
      patient: { id: 'pat-1' } as never,
      created: true,
    });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv-uuid', state: 'waiting_human' } as never,
      created: true,
    });
    vi.mocked(addMessage).mockResolvedValue({
      message: { id: 'msg-1' } as never,
      created: true,
    });

    await kapsoAdapter.handle(buildCtx(baseInbound, 'whatsapp.message.received'));

    expect(getOrCreateConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ initialState: 'waiting_human' }),
    );
  });

  it('dispatches ai/message.received when conversation.state=ai_handling AND message is new', async () => {
    const captured = buildMockSupabase({ agentRow: { id: 'cfg-1' } });
    vi.mocked(createClient).mockReturnValue(captured.client as ReturnType<typeof createClient>);
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({ patient: { id: 'pat-1' } as never, created: true });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv-uuid', state: 'ai_handling' } as never,
      created: true,
    });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg-id-9' } as never, created: true });

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    await kapsoAdapter.handle(buildCtx(baseInbound, 'whatsapp.message.received', {}, { inngestSend }));

    expect(inngestSend).toHaveBeenCalledWith({
      name: 'ai/message.received',
      id: 'ai:msg-id-9',
      data: {
        messageId: 'msg-id-9',
        conversationId: 'conv-uuid',
        clinicId: 'clinic-1',
      },
    });
  });

  it('does NOT dispatch ai/message.received when conversation.state=waiting_human', async () => {
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({ patient: { id: 'pat' } as never, created: false });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv', state: 'waiting_human' } as never,
      created: true,
    });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: true });

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    await kapsoAdapter.handle(buildCtx(baseInbound, 'whatsapp.message.received', {}, { inngestSend }));

    // inngestSend may have been called for status updates in other tests, but this is inbound
    // path — there should be ZERO ai/message.received dispatches.
    const aiCalls = inngestSend.mock.calls.filter((c) => c[0]?.name === 'ai/message.received');
    expect(aiCalls).toHaveLength(0);
  });

  it('does NOT dispatch ai/message.received when message is duplicate (created=false)', async () => {
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({ patient: { id: 'pat' } as never, created: false });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv', state: 'ai_handling' } as never,
      created: false,
    });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: false });

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    await kapsoAdapter.handle(buildCtx(baseInbound, 'whatsapp.message.received', {}, { inngestSend }));

    const aiCalls = inngestSend.mock.calls.filter((c) => c[0]?.name === 'ai/message.received');
    expect(aiCalls).toHaveLength(0);
  });

  it("queries agent_configs filtering by name='agente-principal' (alignment with dispatcher)", async () => {
    const captured = buildMockSupabase({ agentRow: { id: 'cfg-1' } });
    vi.mocked(createClient).mockReturnValue(captured.client as ReturnType<typeof createClient>);
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({
      patient: { id: 'pat-1' } as never,
      created: true,
    });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv-uuid', state: 'ai_handling' } as never,
      created: true,
    });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: true });

    await kapsoAdapter.handle(buildCtx(baseInbound, 'whatsapp.message.received'));

    // Cross-check: the third .eq() call must be ('name', 'agente-principal').
    expect(captured.agentEqNameMock).toHaveBeenCalledWith('name', 'agente-principal');
  });

  it('passes initialState=waiting_human when published agent_config exists with different name', async () => {
    // Mock simulates the post-fix behavior: name='agente-principal' filter
    // applied at SQL level → maybeSingle returns null because the only
    // published agent for this clinic is, say, 'triage'. Without the fix,
    // adapter would set ai_handling, dispatcher would skip on no_agent_config,
    // and the conversation would be stuck.
    const captured = buildMockSupabase({ agentRow: null });
    vi.mocked(createClient).mockReturnValue(captured.client as ReturnType<typeof createClient>);
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({
      patient: { id: 'pat-1' } as never,
      created: true,
    });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv-uuid', state: 'waiting_human' } as never,
      created: true,
    });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: true });

    await kapsoAdapter.handle(buildCtx(baseInbound, 'whatsapp.message.received'));

    expect(getOrCreateConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ initialState: 'waiting_human' }),
    );
  });

  it('does not crash webhook when ai dispatch throws (best-effort, log only)', async () => {
    const captured = buildMockSupabase({ agentRow: { id: 'cfg-1' } });
    vi.mocked(createClient).mockReturnValue(captured.client as ReturnType<typeof createClient>);
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({ patient: { id: 'pat-1' } as never, created: true });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv-uuid', state: 'ai_handling' } as never,
      created: true,
    });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg-id-x' } as never, created: true });

    // First call (status path or whatever) succeeds; ai dispatch (this test) throws.
    const inngestSend = vi.fn().mockRejectedValueOnce(new Error('inngest down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await kapsoAdapter.handle(buildCtx(baseInbound, 'whatsapp.message.received', {}, { inngestSend }));

    expect(result).toEqual({ processed: true, reason: 'message_inserted' });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

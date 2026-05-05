import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const tenantCtx = {
  user: { id: 'user-1', email: 'a@b.com' },
  clinicId: 'clinic-1',
  clinicSlug: 'demo',
  clinicName: 'Demo',
  role: 'admin' as const,
};

const mockGetTenantContext = vi.fn();
const mockGetSupabaseServerClient = vi.fn();

vi.mock('@medina/auth', () => ({
  getTenantContext: () => mockGetTenantContext(),
  getSupabaseServerClient: () => mockGetSupabaseServerClient(),
}));

const mockQueueOutboundMessage = vi.fn();
vi.mock('@medina/chat', () => ({
  queueOutboundMessage: (...args: unknown[]) => mockQueueOutboundMessage(...args),
}));

const mockInngestSend = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));

import { sendMessageAction } from './actions';
import { retryFailedMessageAction } from './retry-action';

// CHAT-2 mock: chainable Supabase client.
// Supports .from(table).select(...).eq(...).is(...).maybeSingle()  (read path)
//      and .from(table).update({...}).eq('id', x)                  (write path)
type RowOrError = { data: Record<string, unknown> | null; errorMsg?: string };
function buildSupabase(opts: {
  conversations?: RowOrError;
  messages?: RowOrError;
  updateError?: string;
}) {
  const updateMock = vi.fn();
  const fromMock = vi.fn((table: string) => {
    const spec =
      table === 'conversations'
        ? opts.conversations ?? { data: null }
        : table === 'messages'
          ? opts.messages ?? { data: null }
          : { data: null };

    const maybeSingle = vi.fn().mockResolvedValue(
      spec.errorMsg
        ? { data: null, error: { message: spec.errorMsg } }
        : { data: spec.data, error: null },
    );
    const isFn = vi.fn().mockReturnValue({ maybeSingle });
    const eq = vi.fn().mockReturnValue({ is: isFn, maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });

    const updateEq = vi.fn().mockResolvedValue(
      opts.updateError ? { error: { message: opts.updateError } } : { error: null },
    );
    const update = (patch: Record<string, unknown>) => {
      updateMock(table, patch);
      return { eq: updateEq };
    };

    return { select, update };
  });
  return { client: { from: fromMock } as unknown, fromMock, updateMock };
}

beforeEach(() => {
  mockGetTenantContext.mockResolvedValue(tenantCtx);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('sendMessageAction zod validation', () => {
  it('rejects empty content', async () => {
    const result = await sendMessageAction({ conversationId: 'a'.repeat(36), content: '' });
    expect(result).toEqual({ error: 'Mensagem inválida.' });
  });

  it('rejects content over 4096 chars', async () => {
    const result = await sendMessageAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      content: 'a'.repeat(4097),
    });
    expect(result).toEqual({ error: 'Mensagem inválida.' });
  });

  it('rejects non-uuid conversationId', async () => {
    const result = await sendMessageAction({ conversationId: 'not-a-uuid', content: 'oi' });
    expect(result).toEqual({ error: 'Mensagem inválida.' });
  });
});

describe('sendMessageAction early returns', () => {
  it('returns error when conversation not found', async () => {
    const sb = buildSupabase({ conversations: { data: null } });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await sendMessageAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      content: 'oi',
    });
    expect(result).toEqual({ error: 'Conversa não encontrada.' });
    expect(mockQueueOutboundMessage).not.toHaveBeenCalled();
  });

  it('rejects when conversation belongs to another clinic (cross-tenant W1)', async () => {
    const sb = buildSupabase({
      conversations: {
        data: { id: 'c', clinic_id: 'clinic-OTHER', integration_id: 'i', external_id: '+1' },
      },
    });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await sendMessageAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      content: 'oi',
    });

    expect(result).toEqual({ error: 'Conversa de outra clínica.' });
    expect(mockQueueOutboundMessage).not.toHaveBeenCalled();
  });
});

describe('sendMessageAction queues via outbox (no synchronous Kapso)', () => {
  it('calls queueOutboundMessage with conversationId, content, senderUserId; returns ok+messageId', async () => {
    const conv = {
      id: '11111111-1111-1111-1111-111111111111',
      clinic_id: 'clinic-1',
      integration_id: 'integ-1',
      external_id: '+5511987654321',
    };
    const sb = buildSupabase({ conversations: { data: conv } });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);
    mockQueueOutboundMessage.mockResolvedValue({ messageId: 'msg-queued-42' });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendMessageAction({ conversationId: conv.id, content: 'olá paciente' });

    expect(result).toEqual({ ok: true, messageId: 'msg-queued-42' });
    expect(mockQueueOutboundMessage).toHaveBeenCalledWith(
      sb.client,
      expect.any(Function),
      {
        clinicId: 'clinic-1',
        conversationId: conv.id,
        content: 'olá paciente',
        senderUserId: 'user-1',
      },
    );
    // Action must NOT hit Kapso directly anymore — that's the worker's job.
    const kapsoCalls = fetchMock.mock.calls.filter((c) => {
      const url = typeof c[0] === 'string' ? c[0] : c[0]?.toString() ?? '';
      return url.includes('kapso.ai');
    });
    expect(kapsoCalls).toHaveLength(0);
  });

  it('surfaces queueOutboundMessage error to caller without crashing', async () => {
    const conv = {
      id: '11111111-1111-1111-1111-111111111111',
      clinic_id: 'clinic-1',
      integration_id: 'integ-1',
      external_id: '+5511987654321',
    };
    const sb = buildSupabase({ conversations: { data: conv } });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);
    mockQueueOutboundMessage.mockRejectedValue(new Error('inngest down'));

    const result = await sendMessageAction({ conversationId: conv.id, content: 'oi' });

    expect('error' in result && result.error).toMatch(/inngest down/);
  });
});

describe('retryFailedMessageAction', () => {
  it('rejects when message not found', async () => {
    const sb = buildSupabase({ messages: { data: null } });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await retryFailedMessageAction({
      messageId: '11111111-1111-1111-1111-111111111111',
    });

    expect(result).toEqual({ error: 'Mensagem não encontrada.' });
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('rejects when message belongs to another clinic (cross-tenant)', async () => {
    const sb = buildSupabase({
      messages: {
        data: {
          id: 'msg-1',
          clinic_id: 'clinic-OTHER',
          conversation_id: 'c-1',
          outbox_status: 'failed',
        },
      },
    });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await retryFailedMessageAction({
      messageId: '11111111-1111-1111-1111-111111111111',
    });

    expect(result).toEqual({ error: 'Mensagem não encontrada.' });
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('rejects when outbox_status is not failed', async () => {
    const sb = buildSupabase({
      messages: {
        data: {
          id: 'msg-1',
          clinic_id: 'clinic-1',
          conversation_id: 'c-1',
          outbox_status: 'sent',
        },
      },
    });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await retryFailedMessageAction({
      messageId: '11111111-1111-1111-1111-111111111111',
    });

    expect(result).toEqual({ error: 'Mensagem não está em estado falho.' });
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('happy path: resets fields, dispatches Inngest event with retry suffix id', async () => {
    const sb = buildSupabase({
      messages: {
        data: {
          id: 'msg-1',
          clinic_id: 'clinic-1',
          conversation_id: 'c-1',
          outbox_status: 'failed',
        },
      },
    });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await retryFailedMessageAction({
      messageId: '11111111-1111-1111-1111-111111111111',
    });

    expect(result).toEqual({ ok: true });
    expect(sb.updateMock).toHaveBeenCalledWith('messages', {
      outbox_status: 'pending',
      delivery_error: null,
      last_error_at: null,
      retry_count: 0,
    });
    expect(mockInngestSend).toHaveBeenCalledTimes(1);
    const dispatched = mockInngestSend.mock.calls[0]![0] as {
      name: string;
      id: string;
      data: Record<string, string>;
    };
    expect(dispatched.name).toBe('chat/message.outbound');
    expect(dispatched.id).toMatch(/^outbound:msg-1:retry-\d+$/);
    expect(dispatched.data).toEqual({
      messageId: 'msg-1',
      clinicId: 'clinic-1',
      conversationId: 'c-1',
    });
  });
});

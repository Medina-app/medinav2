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

const mockAddMessage = vi.fn();
vi.mock('@medina/chat', () => ({
  addMessage: (...args: unknown[]) => mockAddMessage(...args),
}));

import { sendMessageAction } from './actions';

// Build a minimal chainable Supabase client mock that multiplexes by table name.
// Each .from(table) returns a chain whose .maybeSingle() resolves to the row
// for that table (or null + error message if provided).
type RowOrError = { data: Record<string, unknown> | null; errorMsg?: string };
function buildSupabase(opts: {
  conversations?: RowOrError;
  clinic_integrations?: RowOrError;
  rpcCredJson?: string | null;
  rpcError?: string;
}) {
  const fromMock = vi.fn((table: string) => {
    const spec =
      table === 'conversations'
        ? opts.conversations ?? { data: null }
        : table === 'clinic_integrations'
          ? opts.clinic_integrations ?? { data: null }
          : { data: null };
    const maybeSingle = vi.fn().mockResolvedValue(
      spec.errorMsg
        ? { data: null, error: { message: spec.errorMsg } }
        : { data: spec.data, error: null },
    );
    const isFn = vi.fn().mockReturnValue({ maybeSingle });
    const eq = vi.fn().mockReturnValue({ is: isFn });
    const select = vi.fn().mockReturnValue({ eq });
    return { select };
  });
  const rpc = vi.fn().mockResolvedValue(
    opts.rpcError
      ? { data: null, error: { message: opts.rpcError } }
      : { data: opts.rpcCredJson ?? null, error: null },
  );
  return { from: fromMock, rpc };
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
    mockGetSupabaseServerClient.mockReturnValue(buildSupabase({ conversations: { data: null } }));

    const result = await sendMessageAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      content: 'oi',
    });
    expect(result).toEqual({ error: 'Conversa não encontrada.' });
  });

  it('rejects when conversation belongs to another clinic (cross-tenant)', async () => {
    mockGetSupabaseServerClient.mockReturnValue(
      buildSupabase({
        conversations: {
          data: {
            id: 'c',
            clinic_id: 'clinic-OTHER', // ≠ tenantCtx.clinicId ('clinic-1')
            integration_id: 'i',
            external_id: '+1',
          },
        },
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendMessageAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      content: 'oi',
    });

    expect(result).toEqual({ error: 'Conversa de outra clínica.' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('returns error when integration is missing phone_number_id', async () => {
    mockGetSupabaseServerClient.mockReturnValue(
      buildSupabase({
        conversations: { data: { id: 'c', clinic_id: 'clinic-1', integration_id: 'i', external_id: '+1' } },
        clinic_integrations: { data: { id: 'i', status: 'active', config: {} } },
      }),
    );

    const result = await sendMessageAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      content: 'oi',
    });
    expect('error' in result && result.error).toMatch(/phone_number_id ainda não capturado/);
  });
});

describe('sendMessageAction happy path', () => {
  it('fetches creds via sb.rpc, posts to Kapso, inserts outbound message', async () => {
    const conv = {
      id: '11111111-1111-1111-1111-111111111111',
      clinic_id: 'clinic-1',
      integration_id: 'integ-1',
      external_id: '+5511987654321',
    };
    const integ = {
      id: 'integ-1',
      status: 'active',
      config: { phone_number_id: '647015955153740' },
    };
    const credJson = JSON.stringify({ api_key: 'kapso-key-xyz' });

    mockGetSupabaseServerClient.mockReturnValue(
      buildSupabase({
        conversations: { data: conv },
        clinic_integrations: { data: integ },
        rpcCredJson: credJson,
      }),
    );
    mockAddMessage.mockResolvedValue({ message: { id: 'msg-1' }, created: true });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.OUT-1' }] }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendMessageAction({
      conversationId: conv.id,
      content: 'olá paciente',
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.kapso.ai/meta/whatsapp/v24.0/647015955153740/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-API-Key': 'kapso-key-xyz' }),
      }),
    );
    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clinicId: 'clinic-1',
        conversationId: conv.id,
        direction: 'outbound',
        senderType: 'human',
        senderUserId: 'user-1',
        contentType: 'text',
        content: 'olá paciente',
        externalId: 'wamid.OUT-1',
        deliveryStatus: 'sent',
      }),
    );
  });

  it('returns error when Kapso API returns 503', async () => {
    const conv = {
      id: '11111111-1111-1111-1111-111111111111',
      clinic_id: 'clinic-1',
      integration_id: 'integ-1',
      external_id: '+5511987654321',
    };
    const integ = {
      id: 'integ-1',
      status: 'active',
      config: { phone_number_id: '647015955153740' },
    };

    mockGetSupabaseServerClient.mockReturnValue(
      buildSupabase({
        conversations: { data: conv },
        clinic_integrations: { data: integ },
        rpcCredJson: JSON.stringify({ api_key: 'k' }),
      }),
    );

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    }));

    const result = await sendMessageAction({
      conversationId: conv.id,
      content: 'oi',
    });

    expect('error' in result && result.error).toMatch(/Kapso retornou 503/);
    expect(mockAddMessage).not.toHaveBeenCalled();
  });
});

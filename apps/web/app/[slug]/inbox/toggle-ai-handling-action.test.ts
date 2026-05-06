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

import { toggleAiHandlingAction } from './toggle-ai-handling-action';

// Supabase mock supporting:
//   sb.from('conversations').select('clinic_id').eq('id', x).maybeSingle()  (read)
//   sb.rpc('transition_conversation_state', { ... })                        (RPC)
function buildSupabase(opts: {
  conversation?: { clinic_id: string } | null;
  rpcError?: string;
}) {
  const rpcMock = vi
    .fn()
    .mockResolvedValue(opts.rpcError ? { error: { message: opts.rpcError } } : { error: null });

  const maybeSingle = vi
    .fn()
    .mockResolvedValue({ data: opts.conversation ?? null, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });

  return { client: { from, rpc: rpcMock } as unknown, fromMock: from, rpcMock };
}

beforeEach(() => {
  mockGetTenantContext.mockResolvedValue(tenantCtx);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('toggleAiHandlingAction', () => {
  it('rejects invalid newState (zod)', async () => {
    const result = await toggleAiHandlingAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      newState: 'resolved' as never,
    });
    expect(result).toEqual({ error: 'Entrada inválida.' });
  });

  it('rejects non-uuid conversationId (zod)', async () => {
    const result = await toggleAiHandlingAction({
      conversationId: 'not-a-uuid',
      newState: 'ai_handling',
    });
    expect(result).toEqual({ error: 'Entrada inválida.' });
  });

  it('rejects cross-tenant conversation', async () => {
    const sb = buildSupabase({ conversation: { clinic_id: 'clinic-OTHER' } });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await toggleAiHandlingAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      newState: 'ai_handling',
    });

    expect(result).toEqual({ error: 'Conversa não encontrada.' });
    expect(sb.rpcMock).not.toHaveBeenCalled();
  });

  it('returns error when conversation not found', async () => {
    const sb = buildSupabase({ conversation: null });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await toggleAiHandlingAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      newState: 'ai_handling',
    });
    expect(result).toEqual({ error: 'Conversa não encontrada.' });
  });

  it('transitions ai_handling → waiting_human via transition_conversation_state RPC', async () => {
    const sb = buildSupabase({ conversation: { clinic_id: 'clinic-1' } });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await toggleAiHandlingAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      newState: 'waiting_human',
    });

    expect(result).toEqual({ ok: true });
    expect(sb.rpcMock).toHaveBeenCalledWith(
      'transition_conversation_state',
      expect.objectContaining({
        conv_id: '11111111-1111-1111-1111-111111111111',
        new_state: 'waiting_human',
        reason: 'human_paused_ai',
      }),
    );
  });

  it('transitions waiting_human → ai_handling with reason human_returned_to_ai', async () => {
    const sb = buildSupabase({ conversation: { clinic_id: 'clinic-1' } });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await toggleAiHandlingAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      newState: 'ai_handling',
    });

    expect(result).toEqual({ ok: true });
    expect(sb.rpcMock).toHaveBeenCalledWith(
      'transition_conversation_state',
      expect.objectContaining({
        new_state: 'ai_handling',
        reason: 'human_returned_to_ai',
      }),
    );
  });

  it('surfaces RPC error (invalid transition: e.g. resolved → ai_handling)', async () => {
    const sb = buildSupabase({
      conversation: { clinic_id: 'clinic-1' },
      rpcError: 'invalid transition from resolved to ai_handling',
    });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await toggleAiHandlingAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      newState: 'ai_handling',
    });

    expect(result).toEqual({ error: 'invalid transition from resolved to ai_handling' });
  });
});

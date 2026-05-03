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
const mockGetSupabaseAdminClient = vi.fn();

vi.mock('@medina/auth', () => ({
  getTenantContext: () => mockGetTenantContext(),
  getSupabaseServerClient: () => mockGetSupabaseServerClient(),
  getSupabaseAdminClient: () => mockGetSupabaseAdminClient(),
}));

const mockAddMessage = vi.fn();
vi.mock('@medina/chat', () => ({ addMessage: (...args: unknown[]) => mockAddMessage(...args) }));

import { sendMessageAction } from './actions';

function buildSupabaseFromConversation(conv: Record<string, unknown> | null, errorMsg?: string) {
  const maybeSingle = vi.fn().mockResolvedValue(
    errorMsg
      ? { data: null, error: { message: errorMsg } }
      : { data: conv, error: null },
  );
  const isFn = vi.fn().mockReturnValue({ maybeSingle });
  const eq = vi.fn().mockReturnValue({ is: isFn });
  const select = vi.fn().mockReturnValue({ eq });
  return { from: vi.fn().mockReturnValue({ select }) };
}

beforeEach(() => {
  mockGetTenantContext.mockResolvedValue(tenantCtx);
});

afterEach(() => {
  vi.clearAllMocks();
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
    mockGetSupabaseServerClient.mockReturnValue(buildSupabaseFromConversation(null));
    mockGetSupabaseAdminClient.mockReturnValue({});

    const result = await sendMessageAction({
      conversationId: '11111111-1111-1111-1111-111111111111',
      content: 'oi',
    });
    expect(result).toEqual({ error: 'Conversa não encontrada.' });
  });
});

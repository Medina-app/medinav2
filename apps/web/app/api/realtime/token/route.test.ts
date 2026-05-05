import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jwtVerify } from 'jose';

vi.mock('@medina/auth', () => ({
  getTenantContext: vi.fn(),
  getSupabaseServerClient: vi.fn().mockResolvedValue({}),
}));
vi.mock('@medina/chat', () => ({
  listConversations: vi.fn(),
}));

const SECRET = 'test-secret-xxxxxxxxxxxxxxxxxxxxxxxx';

describe('GET /api/realtime/token', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env['CENTRIFUGO_JWT_HMAC_SECRET'] = SECRET;
    process.env['NEXT_PUBLIC_CENTRIFUGO_WSS_URL'] =
      'wss://ws.example.test/connection/websocket';
  });

  it('returns 401 when getTenantContext throws (no session)', async () => {
    const { getTenantContext } = await import('@medina/auth');
    (getTenantContext as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('no session'),
    );
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns 503 when realtime envs are not configured', async () => {
    delete process.env['CENTRIFUGO_JWT_HMAC_SECRET'];
    const { getTenantContext } = await import('@medina/auth');
    const { listConversations } = await import('@medina/chat');
    (getTenantContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: 'u' },
      clinicId: 'c',
    });
    (listConversations as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it('returns token + url with channels for inbox + each active conversation', async () => {
    const { getTenantContext } = await import('@medina/auth');
    const { listConversations } = await import('@medina/chat');
    (getTenantContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: 'user-1' },
      clinicId: 'clinic-a',
    });
    (listConversations as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'conv-1' },
      { id: 'conv-2' },
    ]);
    const { GET } = await import('./route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; url: string };
    expect(body.url).toBe('wss://ws.example.test/connection/websocket');
    const { payload } = await jwtVerify(body.token, new TextEncoder().encode(SECRET));
    expect(payload.sub).toBe('user-1');
    expect(payload['channels']).toEqual([
      'clinic:clinic-a:inbox',
      'clinic:clinic-a:conv:conv-1',
      'clinic:clinic-a:conv:conv-2',
    ]);
  });

  it('cross-tenant isolation: channels do not include other clinics', async () => {
    const { getTenantContext } = await import('@medina/auth');
    const { listConversations } = await import('@medina/chat');
    (getTenantContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: 'user-x' },
      clinicId: 'clinic-x',
    });
    (listConversations as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'conv-1' },
    ]);
    const { GET } = await import('./route');
    const res = await GET();
    const body = (await res.json()) as { token: string };
    const { payload } = await jwtVerify(body.token, new TextEncoder().encode(SECRET));
    const channels = payload['channels'] as string[];
    expect(channels.every((c) => c.startsWith('clinic:clinic-x:'))).toBe(true);
  });
});

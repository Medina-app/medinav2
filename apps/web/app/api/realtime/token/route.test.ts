import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

// Mock @medina/auth's tenant resolver + supabase client. The route now
// resolves the clinic from a query param (because middleware doesn't inject
// x-tenant-slug into /api/* paths) and verifies membership via
// assertTenantAccess.
vi.mock('@medina/auth', () => ({
  assertTenantAccess: vi.fn(),
  getSupabaseServerClient: vi.fn(),
}));
vi.mock('@medina/chat', () => ({
  listConversations: vi.fn(),
}));

const SECRET = 'test-secret-xxxxxxxxxxxxxxxxxxxxxxxx';

function makeReq(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/realtime/token${query}`);
}

function makeAuthedSupabase(userId: string | null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null } }),
    },
  };
}

describe('GET /api/realtime/token', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env['CENTRIFUGO_JWT_HMAC_SECRET'] = SECRET;
    process.env['NEXT_PUBLIC_CENTRIFUGO_WSS_URL'] =
      'wss://ws.example.test/connection/websocket';
  });

  it('returns 400 when clinicSlug query param is missing', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeReq(''));
    expect(res.status).toBe(400);
  });

  it('returns 401 when no authenticated user', async () => {
    const { getSupabaseServerClient } = await import('@medina/auth');
    (getSupabaseServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAuthedSupabase(null),
    );
    const { GET } = await import('./route');
    const res = await GET(makeReq('?clinicSlug=clinic-a'));
    expect(res.status).toBe(401);
  });

  it('returns 401 when user has no access to the requested clinic', async () => {
    const { getSupabaseServerClient, assertTenantAccess } = await import('@medina/auth');
    (getSupabaseServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAuthedSupabase('user-1'),
    );
    (assertTenantAccess as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Access denied to clinic: clinic-other'),
    );
    const { GET } = await import('./route');
    const res = await GET(makeReq('?clinicSlug=clinic-other'));
    expect(res.status).toBe(401);
  });

  it('returns 503 when realtime envs are not configured', async () => {
    delete process.env['CENTRIFUGO_JWT_HMAC_SECRET'];
    const { getSupabaseServerClient, assertTenantAccess } = await import('@medina/auth');
    const { listConversations } = await import('@medina/chat');
    (getSupabaseServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAuthedSupabase('u'),
    );
    (assertTenantAccess as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'c',
      slug: 'c',
      name: 'C',
      role: 'owner',
    });
    (listConversations as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { GET } = await import('./route');
    const res = await GET(makeReq('?clinicSlug=c'));
    expect(res.status).toBe(503);
  });

  it('returns token + url with channels for inbox + each active conversation', async () => {
    const { getSupabaseServerClient, assertTenantAccess } = await import('@medina/auth');
    const { listConversations } = await import('@medina/chat');
    (getSupabaseServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAuthedSupabase('user-1'),
    );
    (assertTenantAccess as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'clinic-a',
      slug: 'clinic-a',
      name: 'Clinic A',
      role: 'owner',
    });
    (listConversations as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'conv-1' },
      { id: 'conv-2' },
    ]);
    const { GET } = await import('./route');
    const res = await GET(makeReq('?clinicSlug=clinic-a'));
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
    const { getSupabaseServerClient, assertTenantAccess } = await import('@medina/auth');
    const { listConversations } = await import('@medina/chat');
    (getSupabaseServerClient as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAuthedSupabase('user-x'),
    );
    (assertTenantAccess as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'clinic-x',
      slug: 'clinic-x',
      name: 'Clinic X',
      role: 'member',
    });
    (listConversations as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'conv-1' }]);
    const { GET } = await import('./route');
    const res = await GET(makeReq('?clinicSlug=clinic-x'));
    const body = (await res.json()) as { token: string };
    const { payload } = await jwtVerify(body.token, new TextEncoder().encode(SECRET));
    const channels = payload['channels'] as string[];
    expect(channels.every((c) => c.startsWith('clinic:clinic-x:'))).toBe(true);
  });
});

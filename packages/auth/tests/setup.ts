import { vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue({
    get: (_key: string) => null,
  }),
  cookies: vi.fn().mockResolvedValue({
    getAll: () => [],
    get: (_name: string) => undefined,
    set: vi.fn(),
  }),
}));

vi.mock('next/server', () => ({
  NextResponse: {
    next: vi.fn().mockImplementation(() => ({
      cookies: { getAll: () => [], set: vi.fn() },
    })),
    redirect: vi.fn(),
  },
}));

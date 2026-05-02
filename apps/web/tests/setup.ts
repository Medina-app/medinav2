import { vi } from 'vitest'

vi.mock('server-only', () => ({}))

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue({ get: (_key: string) => null }),
  cookies: vi.fn().mockResolvedValue({
    getAll: () => [],
    get: (_name: string) => undefined,
    set: vi.fn(),
  }),
}))

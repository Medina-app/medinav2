import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock calls are hoisted to top of file by vitest, so we cannot reference
// module-level variables inside the factory. We build LoginSchema inside the
// factory using a dynamic import of 'zod' to keep it self-contained.
vi.mock('@medina/auth', async () => {
  const { z } = await import('zod')
  const LoginSchema = z.object({
    email: z.string().email('Email inválido'),
    password: z.string().min(6, 'Senha deve ter pelo menos 6 caracteres'),
  })
  return {
    LoginSchema,
    getSupabaseServerClient: vi.fn(),
    listUserClinics: vi.fn(),
  }
})

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { redirect } from 'next/navigation'
import { getSupabaseServerClient, listUserClinics } from '@medina/auth'
import { loginAction } from '../../app/(auth)/login/actions'

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return fd
}

const mockSignIn = vi.fn()
const mockSupabase = { auth: { signInWithPassword: mockSignIn } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSupabaseServerClient).mockResolvedValue(
    mockSupabase as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>,
  )
})

describe('loginAction', () => {
  it('returns Zod error for invalid email', async () => {
    const state = await loginAction(null, makeFormData({ email: 'not-email', password: '123456' }))
    expect(state).toEqual({ error: 'Email inválido' })
    expect(mockSignIn).not.toHaveBeenCalled()
  })

  it('returns Zod error for short password', async () => {
    const state = await loginAction(null, makeFormData({ email: 'a@b.com', password: '12' }))
    expect(state).toEqual({ error: 'Senha deve ter pelo menos 6 caracteres' })
    expect(mockSignIn).not.toHaveBeenCalled()
  })

  it('returns generic error when Supabase rejects credentials', async () => {
    mockSignIn.mockResolvedValue({ data: null, error: { message: 'Invalid login credentials' } })
    const state = await loginAction(null, makeFormData({ email: 'a@b.com', password: 'validpass' }))
    expect(state).toEqual({ error: 'Email ou senha incorretos' })
  })

  it('redirects to first clinic slug on success', async () => {
    mockSignIn.mockResolvedValue({ data: {}, error: null })
    vi.mocked(listUserClinics).mockResolvedValue([
      { id: '1', slug: 'minha-clinica', name: 'Minha Clínica', role: 'owner' },
    ])
    await loginAction(null, makeFormData({ email: 'a@b.com', password: 'validpass' }))
    expect(redirect).toHaveBeenCalledWith('/minha-clinica')
  })

  it('redirects to /onboarding when user has no clinics', async () => {
    mockSignIn.mockResolvedValue({ data: {}, error: null })
    vi.mocked(listUserClinics).mockResolvedValue([])
    await loginAction(null, makeFormData({ email: 'a@b.com', password: 'validpass' }))
    expect(redirect).toHaveBeenCalledWith('/onboarding')
  })
})

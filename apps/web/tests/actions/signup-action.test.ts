import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@medina/auth', async () => {
  const { z } = await import('zod')
  const SignupSchema = z.object({
    name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
    email: z.string().email('Email inválido'),
    password: z.string().min(8, 'Senha deve ter pelo menos 8 caracteres'),
  })
  return {
    SignupSchema,
    getSupabaseServerClient: vi.fn(),
  }
})

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

import { redirect } from 'next/navigation'
import { getSupabaseServerClient } from '@medina/auth'
import { signupAction } from '../../app/(auth)/signup/actions'

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return fd
}

const mockSignUp = vi.fn()
const mockSupabase = { auth: { signUp: mockSignUp } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSupabaseServerClient).mockResolvedValue(
    mockSupabase as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>,
  )
})

describe('signupAction', () => {
  it('returns Zod error for short name', async () => {
    const state = await signupAction(
      null,
      makeFormData({ name: 'A', email: 'a@b.com', password: 'password123' }),
    )
    expect(state).toEqual({ error: 'Nome deve ter pelo menos 2 caracteres' })
    expect(mockSignUp).not.toHaveBeenCalled()
  })

  it('returns Zod error for invalid email', async () => {
    const state = await signupAction(
      null,
      makeFormData({ name: 'Ana', email: 'not-email', password: 'password123' }),
    )
    expect(state).toEqual({ error: 'Email inválido' })
  })

  it('returns Zod error for short password', async () => {
    const state = await signupAction(
      null,
      makeFormData({ name: 'Ana', email: 'a@b.com', password: 'short' }),
    )
    expect(state).toEqual({ error: 'Senha deve ter pelo menos 8 caracteres' })
  })

  it('returns error message when Supabase signUp fails', async () => {
    mockSignUp.mockResolvedValue({ data: null, error: { message: 'User already registered' } })
    const state = await signupAction(
      null,
      makeFormData({ name: 'Ana', email: 'a@b.com', password: 'password123' }),
    )
    expect(state).toEqual({ error: 'User already registered' })
  })

  it('passes full_name in options.data and redirects to /onboarding on success', async () => {
    mockSignUp.mockResolvedValue({ data: { user: {} }, error: null })
    await signupAction(
      null,
      makeFormData({ name: 'Ana Lima', email: 'ana@b.com', password: 'password123' }),
    )
    expect(mockSignUp).toHaveBeenCalledWith({
      email: 'ana@b.com',
      password: 'password123',
      options: { data: { full_name: 'Ana Lima' } },
    })
    expect(redirect).toHaveBeenCalledWith('/onboarding')
  })
})

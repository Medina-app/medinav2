import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@medina/auth', async () => {
  const { z } = await import('zod')
  const CreateClinicSchema = z.object({
    name: z.string()
      .min(2, 'Nome da clínica deve ter pelo menos 2 caracteres')
      .max(100, 'Nome da clínica deve ter no máximo 100 caracteres'),
    slug: z.string()
      .min(3, 'Slug deve ter pelo menos 3 caracteres')
      .max(50, 'Slug deve ter no máximo 50 caracteres')
      .regex(/^[a-z0-9-]+$/, 'Slug deve conter apenas letras minúsculas, números e hífens'),
  })
  return {
    CreateClinicSchema,
    getSupabaseServerClient: vi.fn(),
    getSupabaseAdminClient: vi.fn(),
  }
})

vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { redirect } from 'next/navigation'
import { getSupabaseServerClient, getSupabaseAdminClient } from '@medina/auth'
import { createClinicAction } from '../../app/(auth)/onboarding/actions'

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return fd
}

const mockGetUser = vi.fn()
const mockServerSupabase = { auth: { getUser: mockGetUser } }

type ClinicResult = {
  data: { id: string; slug: string } | null
  error: { message: string; code: string } | null
}
type MemberResult = {
  data: unknown
  error: { message: string; code: string } | null
}

function buildAdmin(clinicResult: ClinicResult, memberResult: MemberResult) {
  const clinicDeleteEq = vi.fn().mockResolvedValue({ data: null, error: null })
  const clinicDeleteFn = vi.fn().mockReturnValue({ eq: clinicDeleteEq })

  const fromFn = vi.fn().mockImplementation((table: string) => {
    if (table === 'clinics') {
      return {
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(clinicResult),
          }),
        }),
        delete: clinicDeleteFn,
      }
    }
    if (table === 'clinic_members') {
      return { insert: vi.fn().mockResolvedValue(memberResult) }
    }
  })

  return { admin: { from: fromFn }, clinicDeleteFn, clinicDeleteEq }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSupabaseServerClient).mockResolvedValue(
    mockServerSupabase as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>,
  )
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
})

describe('createClinicAction', () => {
  it('returns Zod error when slug has uppercase letters', async () => {
    const state = await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clínica', slug: 'MinhaClinica' }),
    )
    expect(state).toEqual({
      error: 'Slug deve conter apenas letras minúsculas, números e hífens',
    })
  })

  it('returns Zod error when slug is too short', async () => {
    const state = await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clínica', slug: 'ab' }),
    )
    expect(state).toEqual({ error: 'Slug deve ter pelo menos 3 caracteres' })
  })

  it('maps Postgres 23505 to slug-already-in-use message', async () => {
    const { admin } = buildAdmin(
      { data: null, error: { message: 'duplicate key', code: '23505' } },
      { data: null, error: null },
    )
    vi.mocked(getSupabaseAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof getSupabaseAdminClient>,
    )
    const state = await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clínica', slug: 'minha-clinica' }),
    )
    expect(state).toEqual({ error: 'Este slug já está em uso. Escolha outro.' })
  })

  it('deletes clinic and returns error when membership insert fails', async () => {
    const { admin, clinicDeleteFn, clinicDeleteEq } = buildAdmin(
      { data: { id: 'clinic-abc', slug: 'minha-clinica' }, error: null },
      { data: null, error: { message: 'FK error', code: '23503' } },
    )
    vi.mocked(getSupabaseAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof getSupabaseAdminClient>,
    )

    const state = await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clínica', slug: 'minha-clinica' }),
    )

    expect(clinicDeleteFn).toHaveBeenCalled()
    expect(clinicDeleteEq).toHaveBeenCalledWith('id', 'clinic-abc')
    expect(state).toEqual({ error: 'Erro ao configurar clínica. Tente novamente.' })
  })

  it('revalidates and redirects to /<slug> on success', async () => {
    const { admin } = buildAdmin(
      { data: { id: 'clinic-xyz', slug: 'minha-clinica' }, error: null },
      { data: {}, error: null },
    )
    vi.mocked(getSupabaseAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof getSupabaseAdminClient>,
    )

    await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clínica', slug: 'minha-clinica' }),
    )
    expect(redirect).toHaveBeenCalledWith('/minha-clinica')
  })
})

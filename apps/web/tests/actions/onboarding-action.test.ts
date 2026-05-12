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

type RpcResult = {
  data: { id: string; slug: string } | Array<{ id: string; slug: string }> | null
  error: { message: string; code: string } | null
}

function buildAdmin(rpcResult: RpcResult) {
  const rpc = vi.fn().mockResolvedValue(rpcResult)
  return { admin: { rpc }, rpc }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSupabaseServerClient).mockResolvedValue(
    mockServerSupabase as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>,
  )
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null })
})

describe('createClinicAction (PR-D #10: atomic create_clinic_with_owner RPC)', () => {
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

  it('chama RPC create_clinic_with_owner com name/slug/user_id', async () => {
    const { admin, rpc } = buildAdmin({
      data: { id: 'clinic-xyz', slug: 'minha-clinica' },
      error: null,
    })
    vi.mocked(getSupabaseAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof getSupabaseAdminClient>,
    )

    await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clínica', slug: 'minha-clinica' }),
    )

    expect(rpc).toHaveBeenCalledWith('create_clinic_with_owner', {
      p_name: 'Minha Clínica',
      p_slug: 'minha-clinica',
      p_user_id: 'user-123',
    })
  })

  it('maps Postgres 23505 to slug-already-in-use message', async () => {
    const { admin } = buildAdmin({
      data: null,
      error: { message: 'duplicate key value violates unique constraint', code: '23505' },
    })
    vi.mocked(getSupabaseAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof getSupabaseAdminClient>,
    )
    const state = await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clínica', slug: 'minha-clinica' }),
    )
    expect(state).toEqual({ error: 'Este slug já está em uso. Escolha outro.' })
  })

  it('returns generic error when RPC errors with unknown code', async () => {
    const { admin } = buildAdmin({
      data: null,
      error: { message: 'connection refused', code: '08000' },
    })
    vi.mocked(getSupabaseAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof getSupabaseAdminClient>,
    )
    const state = await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clínica', slug: 'minha-clinica' }),
    )
    expect(state).toEqual({ error: 'Erro ao criar clínica. Tente novamente.' })
  })

  it('revalidates and redirects to /<slug> on success (RPC returns single row object)', async () => {
    const { admin } = buildAdmin({
      data: { id: 'clinic-xyz', slug: 'minha-clinica' },
      error: null,
    })
    vi.mocked(getSupabaseAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof getSupabaseAdminClient>,
    )

    await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clínica', slug: 'minha-clinica' }),
    )
    expect(redirect).toHaveBeenCalledWith('/minha-clinica')
  })

  it('handles RPC returning array shape (TABLE return type, single-row)', async () => {
    const { admin } = buildAdmin({
      data: [{ id: 'clinic-arr', slug: 'minha-clinica' }],
      error: null,
    })
    vi.mocked(getSupabaseAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof getSupabaseAdminClient>,
    )

    await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clínica', slug: 'minha-clinica' }),
    )
    expect(redirect).toHaveBeenCalledWith('/minha-clinica')
  })

  it('returns generic error if RPC returns empty data without error', async () => {
    const { admin } = buildAdmin({ data: null, error: null })
    vi.mocked(getSupabaseAdminClient).mockReturnValue(
      admin as unknown as ReturnType<typeof getSupabaseAdminClient>,
    )

    const state = await createClinicAction(
      null,
      makeFormData({ name: 'Minha Clínica', slug: 'minha-clinica' }),
    )
    expect(state).toEqual({ error: 'Erro ao criar clínica. Tente novamente.' })
  })
})

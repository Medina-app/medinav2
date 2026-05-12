import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@medina/auth', () => ({
  getTenantContext: vi.fn(),
  getSupabaseServerClient: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  hasPermission: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { getTenantContext, getSupabaseServerClient, getSupabaseAdminClient, hasPermission } from '@medina/auth'
import { inviteMemberAction } from '../../app/[slug]/settings/members/actions'

const ctx = {
  clinicId: 'c1',
  clinicSlug: 's1',
  clinicName: 'Test',
  user: { id: 'u1', email: 'a@b.com' },
  role: 'admin' as const,
}

const mockInsert = vi.fn().mockResolvedValue({ error: null })
const mockSupabase = { from: vi.fn().mockReturnValue({ insert: mockInsert }) }
const mockRpc = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getTenantContext).mockResolvedValue(ctx)
  vi.mocked(getSupabaseServerClient).mockResolvedValue(mockSupabase as never)
  vi.mocked(hasPermission).mockReturnValue(true)
  vi.mocked(getSupabaseAdminClient).mockReturnValue({ rpc: mockRpc } as never)
  mockInsert.mockResolvedValue({ error: null })
  mockRpc.mockResolvedValue({ data: 'u2', error: null })
})

describe('inviteMemberAction (PR-D #9: email-filter via RPC, replaces listUsers)', () => {
  it('returns error for invalid email', async () => {
    const r = await inviteMemberAction({ email: 'not-email', role: 'member' })
    expect(r).toEqual({ error: expect.stringContaining('email') })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('returns error when hasPermission returns false', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    const r = await inviteMemberAction({ email: 'a@b.com', role: 'member' })
    expect(r).toEqual({ error: expect.any(String) })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('chama RPC get_user_id_by_email_internal com p_email (não usa listUsers)', async () => {
    await inviteMemberAction({ email: 'new@test.com', role: 'member' })
    expect(mockRpc).toHaveBeenCalledWith('get_user_id_by_email_internal', {
      p_email: 'new@test.com',
    })
  })

  it('returns "conta no Medina" when RPC returns null (user not found)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null })
    const r = await inviteMemberAction({ email: 'ghost@test.com', role: 'member' })
    expect(r).toEqual({ error: expect.stringContaining('conta no Medina') })
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('returns generic lookup error when RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc down', code: 'XX000' } })
    const r = await inviteMemberAction({ email: 'new@test.com', role: 'member' })
    expect(r.error).toMatch(/buscar usuário/i)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('maps 23505 to duplicate member message', async () => {
    mockInsert.mockResolvedValue({ error: { code: '23505', message: 'dup' } })
    const r = await inviteMemberAction({ email: 'new@test.com', role: 'member' })
    expect(r).toEqual({ error: 'Esse usuário já é membro da clínica.' })
  })

  it('returns success and inserts clinic_members with target user_id from RPC', async () => {
    const r = await inviteMemberAction({ email: 'new@test.com', role: 'member' })
    expect(r).toEqual({ success: true })
    expect(mockSupabase.from).toHaveBeenCalledWith('clinic_members')
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ clinic_id: 'c1', user_id: 'u2', role: 'member' }),
    )
  })
})

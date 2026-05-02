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
const mockListUsers = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getTenantContext).mockResolvedValue(ctx)
  vi.mocked(getSupabaseServerClient).mockResolvedValue(mockSupabase as any)
  vi.mocked(hasPermission).mockReturnValue(true)
  vi.mocked(getSupabaseAdminClient).mockReturnValue({
    auth: { admin: { listUsers: mockListUsers } },
  } as any)
  mockInsert.mockResolvedValue({ error: null })
  mockListUsers.mockResolvedValue({
    data: { users: [{ id: 'u2', email: 'new@test.com', user_metadata: {} }] },
    error: null,
  })
})

describe('inviteMemberAction', () => {
  it('returns error for invalid email', async () => {
    const r = await inviteMemberAction({ email: 'not-email', role: 'member' })
    expect(r).toEqual({ error: expect.stringContaining('email') })
    expect(mockListUsers).not.toHaveBeenCalled()
  })

  it('returns error when hasPermission returns false', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    const r = await inviteMemberAction({ email: 'a@b.com', role: 'member' })
    expect(r).toEqual({ error: expect.any(String) })
    expect(mockListUsers).not.toHaveBeenCalled()
  })

  it('returns "conta no Medina" when user not found', async () => {
    mockListUsers.mockResolvedValue({ data: { users: [] }, error: null })
    const r = await inviteMemberAction({ email: 'ghost@test.com', role: 'member' })
    expect(r).toEqual({ error: expect.stringContaining('conta no Medina') })
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('maps 23505 to duplicate member message', async () => {
    mockInsert.mockResolvedValue({ error: { code: '23505', message: 'dup' } })
    const r = await inviteMemberAction({ email: 'new@test.com', role: 'member' })
    expect(r).toEqual({ error: 'Esse usuário já é membro da clínica.' })
  })

  it('returns success and calls from(clinic_members)', async () => {
    const r = await inviteMemberAction({ email: 'new@test.com', role: 'member' })
    expect(r).toEqual({ success: true })
    expect(mockSupabase.from).toHaveBeenCalledWith('clinic_members')
  })
})

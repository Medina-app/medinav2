import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@medina/auth', () => ({
  getTenantContext: vi.fn(),
  getSupabaseServerClient: vi.fn(),
  hasPermission: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { getTenantContext, getSupabaseServerClient, hasPermission } from '@medina/auth'
import { removeMemberAction } from '../../app/[slug]/settings/members/actions'

const ctx = {
  clinicId: 'c1',
  clinicSlug: 's1',
  clinicName: 'Test',
  user: { id: 'u1', email: 'a@b.com' },
  role: 'admin' as const,
}

const mockEq2 = vi.fn()
const mockEq1 = vi.fn().mockReturnValue({ eq: mockEq2 })
const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq1 })
const mockSupabase = { from: vi.fn().mockReturnValue({ update: mockUpdate }) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getTenantContext).mockResolvedValue(ctx)
  vi.mocked(getSupabaseServerClient).mockResolvedValue(mockSupabase as any)
  vi.mocked(hasPermission).mockReturnValue(true)
  mockEq2.mockResolvedValue({ error: null })
})

describe('removeMemberAction', () => {
  it('returns error for non-UUID userId', async () => {
    const r = await removeMemberAction({ userId: 'not-a-uuid' })
    expect(r).toEqual({ error: expect.any(String) })
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns error when hasPermission returns false', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    const r = await removeMemberAction({ userId: crypto.randomUUID() })
    expect(r).toEqual({ error: expect.any(String) })
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('maps trigger error for last owner removal', async () => {
    mockEq2.mockResolvedValue({ error: { message: 'clinic must have at least one owner' } })
    const r = await removeMemberAction({ userId: crypto.randomUUID() })
    expect(r).toEqual({ error: 'Não é possível remover o último owner.' })
  })

  it('returns success on valid removal', async () => {
    const r = await removeMemberAction({ userId: crypto.randomUUID() })
    expect(r).toEqual({ success: true })
    expect(mockSupabase.from).toHaveBeenCalledWith('clinic_members')
  })
})

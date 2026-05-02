import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@medina/auth', () => ({
  getTenantContext: vi.fn(),
  getSupabaseServerClient: vi.fn(),
  hasPermission: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { getTenantContext, getSupabaseServerClient, hasPermission } from '@medina/auth'
import { updateClinicAction } from '../../app/[slug]/settings/general/actions'

const ctx = {
  clinicId: 'c1',
  clinicSlug: 's1',
  clinicName: 'Test',
  user: { id: 'u1', email: 'a@b.com' },
  role: 'owner' as const,
}

const mockEq = vi.fn()
const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq })
const mockSupabase = { from: vi.fn().mockReturnValue({ update: mockUpdate }) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getTenantContext).mockResolvedValue(ctx)
  vi.mocked(getSupabaseServerClient).mockResolvedValue(mockSupabase as any)
  vi.mocked(hasPermission).mockReturnValue(true)
  mockEq.mockResolvedValue({ error: null })
})

describe('updateClinicAction', () => {
  it('returns error for invalid slug (uppercase + space)', async () => {
    const r = await updateClinicAction({ name: 'OK', slug: 'INVALID SLUG' })
    expect(r).toEqual({ error: expect.stringContaining('slug') })
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns error when hasPermission returns false', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    const r = await updateClinicAction({ name: 'OK', slug: 'valid-slug' })
    expect(r).toEqual({ error: expect.any(String) })
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('maps postgres 23505 to slug conflict message', async () => {
    mockEq.mockResolvedValue({ error: { code: '23505', message: 'duplicate' } })
    const r = await updateClinicAction({ name: 'OK', slug: 'valid-slug' })
    expect(r).toEqual({ error: 'Esse slug já está em uso.' })
  })

  it('returns success on valid update', async () => {
    const r = await updateClinicAction({ name: 'Clínica', slug: 'clinica' })
    expect(r).toEqual({ success: true })
    expect(mockSupabase.from).toHaveBeenCalledWith('clinics')
  })
})

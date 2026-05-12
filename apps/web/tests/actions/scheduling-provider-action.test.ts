import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@medina/auth', () => ({
  getTenantContext: vi.fn(),
  getSupabaseServerClient: vi.fn(),
  hasPermission: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { getTenantContext, getSupabaseServerClient, hasPermission } from '@medina/auth'
import { updateSchedulingProviderAction } from '../../app/[slug]/settings/integrations/actions'

const baseCtx = {
  clinicId: 'c1',
  clinicSlug: 'mednobre',
  clinicName: 'Mednobre',
  user: { id: 'u1', email: 'gabriel@medina.app' },
  role: 'admin' as const,
}

const mockUpdate = vi.fn()
const mockEq = vi.fn()
const mockSupabase = {
  from: vi.fn().mockReturnValue({
    update: mockUpdate.mockReturnValue({ eq: mockEq }),
  }),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getTenantContext).mockResolvedValue(baseCtx)
  vi.mocked(getSupabaseServerClient).mockResolvedValue(mockSupabase as never)
  vi.mocked(hasPermission).mockReturnValue(true)
  mockSupabase.from = vi.fn().mockReturnValue({
    update: mockUpdate.mockReturnValue({ eq: mockEq }),
  })
  mockUpdate.mockReturnValue({ eq: mockEq })
  mockEq.mockResolvedValue({ error: null })
})

describe('updateSchedulingProviderAction (M1a-3)', () => {
  it('Zod rejects invalid provider string', async () => {
    const r = await updateSchedulingProviderAction({ provider: 'random_bad' })
    expect(r.error).toBeDefined()
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('Zod rejects missing provider field', async () => {
    const r = await updateSchedulingProviderAction({})
    expect(r.error).toBeDefined()
  })

  it('rejects when hasPermission(integration:manage) returns false', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    const r = await updateSchedulingProviderAction({ provider: 'pep_ans' })
    expect(r.error).toMatch(/permissão/i)
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('checks integration:manage permission specifically', async () => {
    await updateSchedulingProviderAction({ provider: 'calcom' })
    expect(hasPermission).toHaveBeenCalledWith('admin', 'integration:manage')
  })

  it('updates clinics.scheduling_provider scoped to ctx.clinicId', async () => {
    const r = await updateSchedulingProviderAction({ provider: 'pep_ans' })
    expect(r).toEqual({ success: true })
    expect(mockSupabase.from).toHaveBeenCalledWith('clinics')
    expect(mockUpdate).toHaveBeenCalledWith({ scheduling_provider: 'pep_ans' })
    expect(mockEq).toHaveBeenCalledWith('id', 'c1')
  })

  it('accepts all 3 valid enum values', async () => {
    for (const provider of ['none', 'calcom', 'pep_ans'] as const) {
      mockEq.mockResolvedValueOnce({ error: null })
      const r = await updateSchedulingProviderAction({ provider })
      expect(r).toEqual({ success: true })
    }
  })

  it('propagates supabase error', async () => {
    mockEq.mockResolvedValueOnce({ error: { message: 'connection refused', code: 'XX000' } })
    const r = await updateSchedulingProviderAction({ provider: 'calcom' })
    expect(r.error).toBe('connection refused')
  })
})

import { describe, it, expect, vi } from 'vitest'
import { buildListPepSpecialtiesTool } from '../../src/tools/list-pep-specialties.js'
import type { ToolContext } from '../../src/types.js'

interface ToolWithExecute {
  execute: () => Promise<{
    ok: boolean
    specialties?: Array<{ id: string; ansId: string; name: string }>
    total?: number
  }>
}
const asTool = (t: unknown) => t as ToolWithExecute

/**
 * Build a tailored mock for pep_specialties query: from('pep_specialties')
 * .select(cols).eq('clinic_id', x).eq('active', true).order('name', ...)
 * resolves to { data, error }. _helpers.ts mock doesn't model .order() so
 * we inline pra esse caso.
 */
function buildSpecMock(opts: {
  data?: Array<{ id: string; ans_id: string; name: string }>
  error?: { message: string } | null
}) {
  const eqCalls: Array<[string, unknown]> = []
  const orderThenable = {
    then: (resolve: (v: { data: unknown; error: { message: string } | null }) => void) =>
      resolve({ data: opts.data ?? [], error: opts.error ?? null }),
  }
  const order = vi.fn().mockReturnValue(orderThenable)
  const eqActive = vi.fn((col: string, val: unknown) => {
    eqCalls.push([col, val])
    return { order }
  })
  const eqClinic = vi.fn((col: string, val: unknown) => {
    eqCalls.push([col, val])
    return { eq: eqActive }
  })
  const select = vi.fn().mockReturnValue({ eq: eqClinic })
  const from = vi.fn().mockReturnValue({ select })
  return {
    supabase: { from } as unknown as ToolContext['supabase'],
    spies: { from, select, eqClinic, eqActive, order, eqCalls },
  }
}

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  clinicId: 'clinic-A',
  conversationId: 'conv-1',
  supabase: buildSpecMock({}).supabase,
  ...overrides,
})

describe('list_pep_specialties (M1a-2)', () => {
  it('returns active specialties of own clinic, sorted by name', async () => {
    const mock = buildSpecMock({
      data: [
        { id: 'spec-6', ans_id: '6', name: 'CARDIOLOGIA' },
        { id: 'spec-18', ans_id: '18', name: 'DERMATOLOGIA' },
        { id: 'spec-44', ans_id: '44', name: 'UROLOGIA' },
      ],
    })
    const r = await asTool(buildListPepSpecialtiesTool(ctx({ supabase: mock.supabase }))).execute()

    expect(r.ok).toBe(true)
    expect(r.total).toBe(3)
    expect(r.specialties).toEqual([
      { id: 'spec-6', ansId: '6', name: 'CARDIOLOGIA' },
      { id: 'spec-18', ansId: '18', name: 'DERMATOLOGIA' },
      { id: 'spec-44', ansId: '44', name: 'UROLOGIA' },
    ])
    expect(mock.spies.from).toHaveBeenCalledWith('pep_specialties')
    expect(mock.spies.order).toHaveBeenCalledWith('name', { ascending: true })
  })

  it('filters by clinic_id AND active=true (cross-tenant + soft-delete safe)', async () => {
    const mock = buildSpecMock({ data: [] })
    await asTool(buildListPepSpecialtiesTool(ctx({ supabase: mock.supabase }))).execute()

    // First .eq is clinic_id, second is active
    expect(mock.spies.eqClinic).toHaveBeenCalledWith('clinic_id', 'clinic-A')
    expect(mock.spies.eqActive).toHaveBeenCalledWith('active', true)
  })

  it('returns empty list when no specialties seeded', async () => {
    const mock = buildSpecMock({ data: [] })
    const r = await asTool(buildListPepSpecialtiesTool(ctx({ supabase: mock.supabase }))).execute()
    expect(r.ok).toBe(true)
    expect(r.specialties).toEqual([])
    expect(r.total).toBe(0)
  })

  it('throws when DB query fails (no graceful fallback)', async () => {
    const mock = buildSpecMock({ error: { message: 'connection refused' } })
    await expect(
      asTool(buildListPepSpecialtiesTool(ctx({ supabase: mock.supabase }))).execute(),
    ).rejects.toThrow(/lookup failed: connection refused/)
  })

  it('does NOT require ansClient — local catalog query only', async () => {
    const mock = buildSpecMock({
      data: [{ id: 's', ans_id: '6', name: 'CARDIOLOGIA' }],
    })
    // ctx without ansClient
    const r = await asTool(buildListPepSpecialtiesTool(ctx({ supabase: mock.supabase }))).execute()
    expect(r.ok).toBe(true)
    expect(r.specialties).toHaveLength(1)
  })
})

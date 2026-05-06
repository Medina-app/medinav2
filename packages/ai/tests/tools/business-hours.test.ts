import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildBusinessHoursTool } from '../../src/tools/business-hours.js'
import { buildMockSupabase, buildToolContext } from './_helpers.js'

const SCHEDULE_DEFAULT = {
  timezone: 'America/Sao_Paulo',
  schedule: {
    monday: { open: '08:00', close: '18:00' },
    tuesday: { open: '08:00', close: '18:00' },
    wednesday: { open: '08:00', close: '18:00' },
    thursday: { open: '08:00', close: '18:00' },
    friday: { open: '08:00', close: '18:00' },
    saturday: null,
    sunday: null,
  },
}

interface ToolWithExecute {
  execute: (input: Record<string, never>) => Promise<{
    is_open: boolean
    next_open: string
    current_period: 'morning' | 'afternoon' | 'closed'
    timezone: string
  }>
}
const asTool = (t: unknown) => t as ToolWithExecute

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('check_business_hours', () => {
  it('returns is_open=true on weekday at 10:00 BRT (morning)', async () => {
    // Wed 2026-05-06 10:00 BRT = 13:00 UTC.
    vi.setSystemTime(new Date('2026-05-06T13:00:00Z'))
    const mock = buildMockSupabase({ clinics: { single: { id: 'clinic-A', business_hours: SCHEDULE_DEFAULT } } })
    const r = await asTool(buildBusinessHoursTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({})
    expect(r.is_open).toBe(true)
    expect(r.current_period).toBe('morning')
  })

  it('returns is_open=true at 14:00 BRT (afternoon period)', async () => {
    // Wed 2026-05-06 14:00 BRT = 17:00 UTC.
    vi.setSystemTime(new Date('2026-05-06T17:00:00Z'))
    const mock = buildMockSupabase({ clinics: { single: { id: 'clinic-A', business_hours: SCHEDULE_DEFAULT } } })
    const r = await asTool(buildBusinessHoursTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({})
    expect(r.is_open).toBe(true)
    expect(r.current_period).toBe('afternoon')
  })

  it('returns is_open=false on weekday at 22:00 BRT', async () => {
    // Thu 2026-05-07 01:00 UTC = Wed 2026-05-06 22:00 BRT.
    vi.setSystemTime(new Date('2026-05-07T01:00:00Z'))
    const mock = buildMockSupabase({ clinics: { single: { id: 'clinic-A', business_hours: SCHEDULE_DEFAULT } } })
    const r = await asTool(buildBusinessHoursTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({})
    expect(r.is_open).toBe(false)
    expect(r.current_period).toBe('closed')
  })

  it('returns is_open=false on saturday', async () => {
    // Sat 2026-05-09 13:00 UTC = 10:00 BRT.
    vi.setSystemTime(new Date('2026-05-09T13:00:00Z'))
    const mock = buildMockSupabase({ clinics: { single: { id: 'clinic-A', business_hours: SCHEDULE_DEFAULT } } })
    const r = await asTool(buildBusinessHoursTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({})
    expect(r.is_open).toBe(false)
    expect(r.current_period).toBe('closed')
  })

  it('returns next_open ISO when closed (sunday → monday 08:00 BRT = 11:00 UTC)', async () => {
    // Sun 2026-05-10 13:00 UTC = 10:00 BRT.
    vi.setSystemTime(new Date('2026-05-10T13:00:00Z'))
    const mock = buildMockSupabase({ clinics: { single: { id: 'clinic-A', business_hours: SCHEDULE_DEFAULT } } })
    const r = await asTool(buildBusinessHoursTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({})
    expect(r.is_open).toBe(false)
    // Mon 2026-05-11 08:00 BRT = 11:00 UTC.
    expect(r.next_open).toBe('2026-05-11T11:00:00.000Z')
  })

  it('returns next_open today when before open hour', async () => {
    // Wed 2026-05-06 06:00 BRT = 09:00 UTC.
    vi.setSystemTime(new Date('2026-05-06T09:00:00Z'))
    const mock = buildMockSupabase({ clinics: { single: { id: 'clinic-A', business_hours: SCHEDULE_DEFAULT } } })
    const r = await asTool(buildBusinessHoursTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({})
    expect(r.is_open).toBe(false)
    expect(r.next_open).toBe('2026-05-06T11:00:00.000Z')
  })

  it('returns next_open tomorrow when after close hour on weekday', async () => {
    // Wed 2026-05-06 19:00 BRT = 22:00 UTC.
    vi.setSystemTime(new Date('2026-05-06T22:00:00Z'))
    const mock = buildMockSupabase({ clinics: { single: { id: 'clinic-A', business_hours: SCHEDULE_DEFAULT } } })
    const r = await asTool(buildBusinessHoursTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({})
    expect(r.is_open).toBe(false)
    // Thu 2026-05-07 08:00 BRT = 11:00 UTC.
    expect(r.next_open).toBe('2026-05-07T11:00:00.000Z')
  })

  it('falls back to default schedule when clinic.business_hours is null', async () => {
    vi.setSystemTime(new Date('2026-05-06T13:00:00Z')) // Wed 10h BRT
    const mock = buildMockSupabase({ clinics: { single: { id: 'clinic-A', business_hours: null } } })
    const r = await asTool(buildBusinessHoursTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({})
    expect(r.is_open).toBe(true)
    expect(r.timezone).toBe('America/Sao_Paulo')
  })

  it('returns timezone in result', async () => {
    vi.setSystemTime(new Date('2026-05-06T13:00:00Z'))
    const mock = buildMockSupabase({ clinics: { single: { id: 'clinic-A', business_hours: SCHEDULE_DEFAULT } } })
    const r = await asTool(buildBusinessHoursTool(buildToolContext({ supabase: mock.supabase as never })))
      .execute({})
    expect(r.timezone).toBe('America/Sao_Paulo')
  })
})

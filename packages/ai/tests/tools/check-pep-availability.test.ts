import { describe, it, expect, vi } from 'vitest'
import { buildCheckPepAvailabilityTool } from '../../src/tools/check-pep-availability.js'
import { buildMockSupabase, buildToolContext } from './_helpers.js'

interface ToolExecResult {
  ok: boolean
  error?: string
  doctorName?: string
  byDate?: Record<string, Array<{ startTime: string; endTime: string }>>
  totalDaysAvailable?: number
  message?: string
}
interface ToolWithExecute {
  execute: (input: { doctorId: string; dateFrom: string; dateTo: string }) => Promise<ToolExecResult>
}
const asTool = (t: unknown) => t as ToolWithExecute

function buildAnsMock(opts: {
  days?: Array<{ date: string; slotsCount?: number }>
  hoursByDate?: Record<string, Array<{ startTime: string; endTime: string; durationMinutes?: number }>>
}) {
  return {
    lookupPatientByPhone: vi.fn(),
    listAvailableDays: vi.fn().mockResolvedValue(opts.days ?? []),
    listAvailableHours: vi.fn(async (args: { date: string }) => opts.hoursByDate?.[args.date] ?? []),
  }
}

const DOCTOR_ID = '00000000-0000-0000-0000-000000000099'

describe('check_pep_availability (M1a-2)', () => {
  it('returns ok:false pep_ans_not_configured when ansClient undefined', async () => {
    const r = await asTool(buildCheckPepAvailabilityTool(buildToolContext())).execute({
      doctorId: DOCTOR_ID,
      dateFrom: '2026-06-01',
      dateTo: '2026-06-07',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('pep_ans_not_configured')
  })

  it('returns doctor_not_found when pep_doctors lookup yields null (cross-tenant guard)', async () => {
    const mock = buildMockSupabase({
      pep_doctors: { maybeSingle: null },
    })
    const ansClient = buildAnsMock({})
    const r = await asTool(
      buildCheckPepAvailabilityTool(
        buildToolContext({ supabase: mock.supabase as never, ansClient: ansClient as never }),
      ),
    ).execute({ doctorId: DOCTOR_ID, dateFrom: '2026-06-01', dateTo: '2026-06-07' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('doctor_not_found')
    expect(ansClient.listAvailableDays).not.toHaveBeenCalled()
  })

  it('returns doctor_inactive when found but active=false', async () => {
    const mock = buildMockSupabase({
      pep_doctors: {
        maybeSingle: { id: DOCTOR_ID, ans_id: 'ans-1', full_name: 'Dr. Off', active: false },
      },
    })
    const ansClient = buildAnsMock({})
    const r = await asTool(
      buildCheckPepAvailabilityTool(
        buildToolContext({ supabase: mock.supabase as never, ansClient: ansClient as never }),
      ),
    ).execute({ doctorId: DOCTOR_ID, dateFrom: '2026-06-01', dateTo: '2026-06-07' })
    expect(r.error).toBe('doctor_inactive')
  })

  it('returns empty byDate + totalDaysAvailable=0 when ANS has no days available', async () => {
    const mock = buildMockSupabase({
      pep_doctors: {
        maybeSingle: { id: DOCTOR_ID, ans_id: 'ans-1', full_name: 'Dr. Real', active: true },
      },
    })
    const ansClient = buildAnsMock({ days: [] })
    const r = await asTool(
      buildCheckPepAvailabilityTool(
        buildToolContext({ supabase: mock.supabase as never, ansClient: ansClient as never }),
      ),
    ).execute({ doctorId: DOCTOR_ID, dateFrom: '2026-06-01', dateTo: '2026-06-07' })
    expect(r.ok).toBe(true)
    expect(r.byDate).toEqual({})
    expect(r.totalDaysAvailable).toBe(0)
  })

  it('truncates to 3 days × 10 hours and returns startTime+endTime per slot', async () => {
    const mock = buildMockSupabase({
      pep_doctors: {
        maybeSingle: { id: DOCTOR_ID, ans_id: 'ans-1', full_name: 'Dr. Real', active: true },
      },
    })
    const days = [
      { date: '2026-06-01', slotsCount: 5 },
      { date: '2026-06-02', slotsCount: 3 },
      { date: '2026-06-03', slotsCount: 12 },
      { date: '2026-06-04', slotsCount: 2 }, // truncated
    ]
    const manyHours = Array.from({ length: 15 }, (_, i) => ({
      startTime: `${String(9 + i).padStart(2, '0')}:00`,
      endTime: `${String(9 + i).padStart(2, '0')}:30`,
      durationMinutes: 30,
    }))
    const ansClient = buildAnsMock({
      days,
      hoursByDate: {
        '2026-06-01': manyHours,
        '2026-06-02': manyHours,
        '2026-06-03': manyHours,
      },
    })
    const r = await asTool(
      buildCheckPepAvailabilityTool(
        buildToolContext({ supabase: mock.supabase as never, ansClient: ansClient as never }),
      ),
    ).execute({ doctorId: DOCTOR_ID, dateFrom: '2026-06-01', dateTo: '2026-06-30' })

    expect(r.ok).toBe(true)
    expect(r.totalDaysAvailable).toBe(4) // reported as ANS returned
    expect(Object.keys(r.byDate ?? {})).toHaveLength(3) // truncated to 3
    expect(r.byDate?.['2026-06-01']?.length).toBe(10) // truncated to 10
    expect(r.byDate?.['2026-06-01']?.[0]).toEqual({ startTime: '09:00', endTime: '09:30' })
    // Listed hours called only for the 3 selected days
    expect(ansClient.listAvailableHours).toHaveBeenCalledTimes(3)
  })

  it('Zod rejects invalid date format (does not call ansClient)', () => {
    const tool = buildCheckPepAvailabilityTool(
      buildToolContext({
        ansClient: { listAvailableDays: vi.fn(), listAvailableHours: vi.fn(), lookupPatientByPhone: vi.fn() } as never,
      }),
    )
    const parsed = (
      tool as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }
    ).inputSchema.safeParse({
      doctorId: DOCTOR_ID,
      dateFrom: '01/06/2026', // wrong format
      dateTo: '2026-06-07',
    })
    expect(parsed.success).toBe(false)
  })

  it('Zod rejects dateTo before dateFrom', () => {
    const tool = buildCheckPepAvailabilityTool(buildToolContext())
    const parsed = (
      tool as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }
    ).inputSchema.safeParse({
      doctorId: DOCTOR_ID,
      dateFrom: '2026-06-10',
      dateTo: '2026-06-01',
    })
    expect(parsed.success).toBe(false)
  })
})

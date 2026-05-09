import { describe, it, expect, vi } from 'vitest'
import { buildCheckAvailabilityTool } from '../../src/tools/check-availability.js'
import { buildMockSupabase } from './_helpers.js'
import type { CalcomClientLike, ToolContext } from '../../src/types.js'

function makeMockClient(slots: Array<{ start: string; end: string }> = []): CalcomClientLike {
  return {
    getAvailability: vi.fn().mockResolvedValue(slots),
    createBooking: vi.fn(),
    cancelBooking: vi.fn(),
    rescheduleBooking: vi.fn(),
  }
}

interface ExecuteFn {
  (input: unknown): Promise<unknown>
}

function getExec(tool: unknown): ExecuteFn {
  return (tool as { execute: ExecuteFn }).execute
}

describe('check_availability tool', () => {
  it('happy path: retorna slots truncados a 10', async () => {
    const slots = Array.from({ length: 15 }, (_, i) => ({
      start: `2026-06-01T${String(10 + i).padStart(2, '0')}:00:00Z`,
      end: `2026-06-01T${String(10 + i).padStart(2, '0')}:30:00Z`,
    }))
    const calcomClient = makeMockClient(slots)
    const { supabase } = buildMockSupabase({
      doctors: {
        maybeSingle: {
          id: 'doc-1',
          calcom_user_id: 'cal-1',
          calcom_event_type_ids: ['42'],
          full_name: 'Dr. Silva',
        },
      },
    })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient,
    }
    const result = (await getExec(buildCheckAvailabilityTool(ctx))({
      doctorId: '11111111-1111-1111-1111-111111111111',
      dateFrom: '2026-06-01T00:00:00Z',
      dateTo: '2026-06-02T00:00:00Z',
    })) as { ok: true; slots: unknown[]; totalAvailable: number }

    expect(result.ok).toBe(true)
    expect(result.slots).toHaveLength(10)
    expect(result.totalAvailable).toBe(15)
    expect(calcomClient.getAvailability).toHaveBeenCalledWith({
      eventTypeId: 42,
      startTime: '2026-06-01T00:00:00Z',
      endTime: '2026-06-02T00:00:00Z',
    })
  })

  it('calcomClient ausente → ok:false calcom_not_configured (sem throw)', async () => {
    const { supabase } = buildMockSupabase()
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
    }
    const result = (await getExec(buildCheckAvailabilityTool(ctx))({
      doctorId: '11111111-1111-1111-1111-111111111111',
      dateFrom: '2026-06-01T00:00:00Z',
      dateTo: '2026-06-02T00:00:00Z',
    })) as { ok: false; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('calcom_not_configured')
  })

  it('doctor não encontrado (cross-tenant) → doctor_not_found', async () => {
    const calcomClient = makeMockClient([])
    const { supabase } = buildMockSupabase({ doctors: { maybeSingle: null } })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient,
    }
    const result = (await getExec(buildCheckAvailabilityTool(ctx))({
      doctorId: '11111111-1111-1111-1111-111111111111',
      dateFrom: '2026-06-01T00:00:00Z',
      dateTo: '2026-06-02T00:00:00Z',
    })) as { ok: false; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('doctor_not_found')
    expect(calcomClient.getAvailability).not.toHaveBeenCalled()
  })

  it('doctor sem calcom_event_type_ids + sem default → doctor_not_calcom_linked', async () => {
    const calcomClient = makeMockClient([])
    const { supabase } = buildMockSupabase({
      doctors: {
        maybeSingle: {
          id: 'doc-1',
          calcom_user_id: null,
          calcom_event_type_ids: null,
          full_name: 'Dr. NoCal',
        },
      },
    })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient,
    }
    const result = (await getExec(buildCheckAvailabilityTool(ctx))({
      doctorId: '11111111-1111-1111-1111-111111111111',
      dateFrom: '2026-06-01T00:00:00Z',
      dateTo: '2026-06-02T00:00:00Z',
    })) as { ok: false; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('doctor_not_calcom_linked')
  })

  it('doctor sem event_type_ids mas com clinic default → usa default', async () => {
    const calcomClient = makeMockClient([{ start: '2026-06-01T10:00:00Z', end: '2026-06-01T10:30:00Z' }])
    const { supabase } = buildMockSupabase({
      doctors: {
        maybeSingle: {
          id: 'doc-1',
          calcom_user_id: 'cal-1',
          calcom_event_type_ids: null,
          full_name: 'Dr. Default',
        },
      },
    })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient,
      calcomDefaultEventTypeId: 99,
    }
    const result = (await getExec(buildCheckAvailabilityTool(ctx))({
      doctorId: '11111111-1111-1111-1111-111111111111',
      dateFrom: '2026-06-01T00:00:00Z',
      dateTo: '2026-06-02T00:00:00Z',
    })) as { ok: true }
    expect(result.ok).toBe(true)
    expect(calcomClient.getAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ eventTypeId: 99 }),
    )
  })

  it('zero slots → ok:true com array vazio (não erro)', async () => {
    const calcomClient = makeMockClient([])
    const { supabase } = buildMockSupabase({
      doctors: {
        maybeSingle: {
          id: 'doc-1',
          calcom_user_id: 'cal-1',
          calcom_event_type_ids: ['42'],
          full_name: 'Dr. Busy',
        },
      },
    })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient,
    }
    const result = (await getExec(buildCheckAvailabilityTool(ctx))({
      doctorId: '11111111-1111-1111-1111-111111111111',
      dateFrom: '2026-06-01T00:00:00Z',
      dateTo: '2026-06-02T00:00:00Z',
    })) as { ok: true; slots: unknown[]; totalAvailable: number }
    expect(result.ok).toBe(true)
    expect(result.slots).toHaveLength(0)
    expect(result.totalAvailable).toBe(0)
  })
})

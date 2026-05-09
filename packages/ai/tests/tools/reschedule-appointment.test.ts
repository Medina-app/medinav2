import { describe, it, expect, vi } from 'vitest'
import { buildRescheduleAppointmentTool } from '../../src/tools/reschedule-appointment.js'
import type { CalcomClientLike, ToolContext } from '../../src/types.js'

interface SbOpts {
  appointment?: unknown | null
  updateError?: { message: string } | null
}

function buildSb(opts: SbOpts) {
  const insertCalls: Array<{ table: string; payload: unknown }> = []
  const updateCalls: Array<{ table: string; payload: unknown }> = []
  const updErr = opts.updateError ?? null

  const from = vi.fn((table: string) => {
    const selChain = {
      eq: vi.fn(() => selChain),
      maybeSingle: vi.fn().mockResolvedValue({
        data: table === 'appointments' ? opts.appointment ?? null : null,
        error: null,
      }),
    }
    const select = vi.fn(() => selChain)

    const insert = vi.fn((payload: unknown) => {
      insertCalls.push({ table, payload })
      return { then: (r: (v: { error: null }) => void) => r({ error: null }) }
    })

    const update = vi.fn((payload: unknown) => {
      updateCalls.push({ table, payload })
      const eqResult = {
        eq: vi.fn(() => eqResult),
        then: (r: (v: { error: { message: string } | null }) => void) => r({ error: updErr }),
      }
      return { eq: vi.fn(() => eqResult) }
    })
    return { select, insert, update }
  })

  return { supabase: { from } as unknown, insertCalls, updateCalls }
}

function makeClient(): CalcomClientLike {
  return {
    getAvailability: vi.fn(),
    createBooking: vi.fn(),
    cancelBooking: vi.fn(),
    rescheduleBooking: vi.fn().mockResolvedValue({
      id: 1000,
      uid: 'new-cal-uid',
    }),
  }
}

const baseAppt = {
  id: 'appt-1',
  status: 'scheduled',
  calcom_uid: 'old-cal-uid',
  doctor_id: 'doc-1',
  start_at: '2026-06-01T10:00:00Z',
  end_at: '2026-06-01T10:30:00Z',
}

const baseInput = {
  appointmentId: '11111111-1111-1111-1111-111111111111',
  newStartAt: '2026-06-02T14:00:00Z',
}

interface ExecuteFn { (input: unknown): Promise<unknown> }
function getExec(tool: unknown): ExecuteFn {
  return (tool as { execute: ExecuteFn }).execute
}

describe('reschedule_appointment tool', () => {
  it('happy path: Cal.com reschedule + UPDATE local + message + audit', async () => {
    const client = makeClient()
    const { supabase, insertCalls, updateCalls } = buildSb({ appointment: baseAppt })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    const result = (await getExec(buildRescheduleAppointmentTool(ctx))(baseInput)) as {
      ok: true
      newCalcomUid: string
    }
    expect(result.ok).toBe(true)
    expect(result.newCalcomUid).toBe('new-cal-uid')
    expect(client.rescheduleBooking).toHaveBeenCalledWith('old-cal-uid', '2026-06-02T14:00:00Z')

    const apptUpdate = updateCalls.find((c) => c.table === 'appointments')
    expect(apptUpdate).toBeDefined()
    const payload = apptUpdate?.payload as {
      calcom_uid: string
      start_at: string
      status: string
    }
    expect(payload.calcom_uid).toBe('new-cal-uid')
    expect(payload.start_at).toBe('2026-06-02T14:00:00Z')
    expect(payload.status).toBe('rescheduled')
    expect(insertCalls.find((c) => c.table === 'messages')).toBeDefined()
    expect(insertCalls.find((c) => c.table === 'audit_logs')).toBeDefined()
  })

  it('appt não encontrado → ok:false', async () => {
    const client = makeClient()
    const { supabase } = buildSb({ appointment: null })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    const result = (await getExec(buildRescheduleAppointmentTool(ctx))(baseInput)) as {
      ok: false
      error: string
    }
    expect(result.error).toBe('appointment_not_found')
    expect(client.rescheduleBooking).not.toHaveBeenCalled()
  })

  it('appt em status terminal (completed) → cannot_reschedule_terminal', async () => {
    const client = makeClient()
    const { supabase } = buildSb({ appointment: { ...baseAppt, status: 'completed' } })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    const result = (await getExec(buildRescheduleAppointmentTool(ctx))(baseInput)) as {
      ok: false
      error: string
    }
    expect(result.error).toBe('cannot_reschedule_terminal')
  })

  it('appt cancelled → cannot_reschedule_terminal', async () => {
    const client = makeClient()
    const { supabase } = buildSb({
      appointment: { ...baseAppt, status: 'cancelled_by_patient' },
    })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    const result = (await getExec(buildRescheduleAppointmentTool(ctx))(baseInput)) as {
      ok: false
      error: string
    }
    expect(result.error).toBe('cannot_reschedule_terminal')
  })

  it('appt sem calcom_uid → no_calcom_uid', async () => {
    const client = makeClient()
    const { supabase } = buildSb({ appointment: { ...baseAppt, calcom_uid: null } })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    const result = (await getExec(buildRescheduleAppointmentTool(ctx))(baseInput)) as {
      ok: false
      error: string
    }
    expect(result.error).toBe('no_calcom_uid')
    expect(client.rescheduleBooking).not.toHaveBeenCalled()
  })

  it('UPDATE falha após Cal.com OK → audit partial_failure + throw', async () => {
    const client = makeClient()
    const { supabase, insertCalls } = buildSb({
      appointment: baseAppt,
      updateError: { message: 'unique violation calcom_uid' },
    })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    await expect(getExec(buildRescheduleAppointmentTool(ctx))(baseInput)).rejects.toThrow(
      /db update/,
    )
    expect(insertCalls.find(
      (c) =>
        c.table === 'audit_logs' &&
        (c.payload as { action: string }).action ===
          'agent.tool.reschedule_appointment.partial_failure',
    )).toBeDefined()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { buildCancelAppointmentTool } from '../../src/tools/cancel-appointment.js'
import type { CalcomClientLike, ToolContext } from '../../src/types.js'

interface SbOpts {
  appointment?: unknown | null
  rpcError?: { message: string } | null
}

function buildSb(opts: SbOpts) {
  const insertCalls: Array<{ table: string; payload: unknown }> = []
  const rpcCalls: Array<{ name: string; args: unknown }> = []

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
    return { select, insert }
  })

  const rpc = vi.fn((name: string, args: unknown) => {
    rpcCalls.push({ name, args })
    return Promise.resolve({ data: null, error: opts.rpcError ?? null })
  })

  return { supabase: { from, rpc } as unknown, insertCalls, rpcCalls }
}

function makeClient(): CalcomClientLike {
  return {
    getAvailability: vi.fn(),
    createBooking: vi.fn(),
    cancelBooking: vi.fn().mockResolvedValue(undefined),
    rescheduleBooking: vi.fn(),
  }
}

const baseAppt = {
  id: 'appt-1',
  status: 'scheduled',
  calcom_uid: 'cal-uid-1',
  doctor_id: 'doc-1',
  start_at: '2026-06-01T10:00:00Z',
}

const baseInput = {
  appointmentId: '11111111-1111-1111-1111-111111111111',
  reason: 'paciente desistiu',
}

interface ExecuteFn { (input: unknown): Promise<unknown> }
function getExec(tool: unknown): ExecuteFn {
  return (tool as { execute: ExecuteFn }).execute
}

describe('cancel_appointment tool', () => {
  it('happy path: cancela Cal.com + RPC + message + audit', async () => {
    const client = makeClient()
    const { supabase, insertCalls, rpcCalls } = buildSb({ appointment: baseAppt })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    const result = (await getExec(buildCancelAppointmentTool(ctx))(baseInput)) as { ok: true }

    expect(result.ok).toBe(true)
    expect(client.cancelBooking).toHaveBeenCalledWith('cal-uid-1', 'paciente desistiu')
    expect(rpcCalls[0]?.name).toBe('transition_appointment_status')
    expect(insertCalls.find((c) => c.table === 'messages')).toBeDefined()
    expect(insertCalls.find((c) => c.table === 'audit_logs' && (c.payload as {action: string}).action === 'agent.tool.cancel_appointment')).toBeDefined()
  })

  it('appointment não encontrado (cross-tenant) → ok:false', async () => {
    const client = makeClient()
    const { supabase } = buildSb({ appointment: null })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    const result = (await getExec(buildCancelAppointmentTool(ctx))(baseInput)) as {
      ok: false
      error: string
    }
    expect(result.error).toBe('appointment_not_found')
    expect(client.cancelBooking).not.toHaveBeenCalled()
  })

  it('appt já cancelado → ok:false already_cancelled', async () => {
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
    const result = (await getExec(buildCancelAppointmentTool(ctx))(baseInput)) as {
      ok: false
      error: string
    }
    expect(result.error).toBe('already_cancelled')
  })

  it('Cal.com 404 (booking already cancelled externamente) → graceful, segue local', async () => {
    const client = makeClient()
    const err = new Error('Booking cal-uid-1 not found in Cal.com')
    err.name = 'CalBookingNotFoundError'
    client.cancelBooking = vi.fn().mockRejectedValue(err)
    const { supabase, rpcCalls } = buildSb({ appointment: baseAppt })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    const result = (await getExec(buildCancelAppointmentTool(ctx))(baseInput)) as { ok: true }
    expect(result.ok).toBe(true)
    expect(rpcCalls[0]?.name).toBe('transition_appointment_status')
  })

  it('RPC transition falha após Cal.com OK → audit partial_failure + throw', async () => {
    const client = makeClient()
    const { supabase, insertCalls } = buildSb({
      appointment: baseAppt,
      rpcError: { message: 'invalid transition' },
    })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    await expect(getExec(buildCancelAppointmentTool(ctx))(baseInput)).rejects.toThrow(
      /db transition/,
    )
    expect(insertCalls.find(
      (c) =>
        c.table === 'audit_logs' &&
        (c.payload as { action: string }).action === 'agent.tool.cancel_appointment.partial_failure',
    )).toBeDefined()
  })

  it('appointment sem calcom_uid (origem manual) → cancela apenas local', async () => {
    const client = makeClient()
    const { supabase, rpcCalls } = buildSb({
      appointment: { ...baseAppt, calcom_uid: null },
    })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    const result = (await getExec(buildCancelAppointmentTool(ctx))(baseInput)) as { ok: true }
    expect(result.ok).toBe(true)
    expect(client.cancelBooking).not.toHaveBeenCalled()
    expect(rpcCalls[0]?.name).toBe('transition_appointment_status')
  })
})

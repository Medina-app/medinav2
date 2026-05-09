import { describe, it, expect, vi } from 'vitest'
import { buildConfirmAppointmentTool } from '../../src/tools/confirm-appointment.js'
import type { CalcomClientLike, ToolContext } from '../../src/types.js'

interface MockOpts {
  doctor?: unknown | null
  patient?: unknown | null
  insertApptError?: { message: string } | null
  apptInsertedId?: string
}

function buildSb(opts: MockOpts) {
  const insertCalls: Array<{ table: string; payload: unknown }> = []
  const tablesData = {
    doctors: opts.doctor ?? null,
    patients: opts.patient ?? null,
  }
  const apptId = opts.apptInsertedId ?? 'appt-1'
  const apptErr = opts.insertApptError ?? null

  const from = vi.fn((table: string) => {
    const selChain = {
      eq: vi.fn(() => selChain),
      maybeSingle: vi.fn().mockResolvedValue({
        data: (tablesData as Record<string, unknown>)[table] ?? null,
        error: null,
      }),
      single: vi.fn().mockResolvedValue({
        data: (tablesData as Record<string, unknown>)[table] ?? null,
        error: null,
      }),
    }
    const select = vi.fn(() => selChain)

    const insert = vi.fn((payload: unknown) => {
      insertCalls.push({ table, payload })
      // appointments INSERT retorna {id} via .select().single()
      if (table === 'appointments') {
        return {
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: apptErr ? null : { id: apptId },
              error: apptErr,
            }),
          })),
          then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
        }
      }
      // messages/audit_logs: bare insert (no .select)
      return {
        select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: null, error: null }) })),
        then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
      }
    })

    return { select, insert, update: vi.fn() }
  })

  return { supabase: { from } as unknown, insertCalls }
}

function makeClient(): CalcomClientLike & {
  createBooking: ReturnType<typeof vi.fn>
  cancelBooking: ReturnType<typeof vi.fn>
} {
  return {
    getAvailability: vi.fn(),
    createBooking: vi.fn().mockResolvedValue({
      id: 999,
      uid: 'cal-uid-123',
      startTime: '2026-06-01T10:00:00Z',
      endTime: '2026-06-01T10:30:00Z',
    }),
    cancelBooking: vi.fn().mockResolvedValue(undefined),
    rescheduleBooking: vi.fn(),
  }
}

const baseInput = {
  doctorId: '11111111-1111-1111-1111-111111111111',
  patientId: '22222222-2222-2222-2222-222222222222',
  startAt: '2026-06-01T10:00:00Z',
}

const baseDoctor = {
  id: '11111111-1111-1111-1111-111111111111',
  calcom_user_id: 'cal-1',
  calcom_event_type_ids: ['42'],
  full_name: 'Dr. Silva',
  consultation_duration_minutes: 30,
}

const basePatientWithEmail = {
  id: '22222222-2222-2222-2222-222222222222',
  full_name: 'João Paciente',
  email: 'joao@example.com',
}

const basePatientNoEmail = { ...basePatientWithEmail, email: null }

interface ExecuteFn {
  (input: unknown): Promise<unknown>
}
function getExec(tool: unknown): ExecuteFn {
  return (tool as { execute: ExecuteFn }).execute
}

describe('confirm_appointment tool', () => {
  it('happy path: booking + INSERT appt + message + audit', async () => {
    const client = makeClient()
    const { supabase, insertCalls } = buildSb({
      doctor: baseDoctor,
      patient: basePatientWithEmail,
    })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    const result = (await getExec(buildConfirmAppointmentTool(ctx))(baseInput)) as {
      ok: true
      appointmentId: string
      calcomUid: string
    }

    expect(result.ok).toBe(true)
    expect(result.calcomUid).toBe('cal-uid-123')
    expect(client.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        eventTypeId: 42,
        attendee: expect.objectContaining({ email: 'joao@example.com' }),
      }),
    )
    expect(insertCalls.find((c) => c.table === 'appointments')).toBeDefined()
    expect(insertCalls.find((c) => c.table === 'messages')).toBeDefined()
    expect(insertCalls.find((c) => c.table === 'audit_logs')).toBeDefined()
    expect(client.cancelBooking).not.toHaveBeenCalled()
  })

  it('email policy híbrida: paciente sem email → placeholder', async () => {
    const client = makeClient()
    const { supabase } = buildSb({ doctor: baseDoctor, patient: basePatientNoEmail })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    await getExec(buildConfirmAppointmentTool(ctx))(baseInput)
    const callArg = (client.createBooking as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      attendee: { email: string }
    }
    expect(callArg.attendee.email).toBe(`${basePatientNoEmail.id}@whatsapp.medina.app`)
  })

  it('rollback: DB insert falha após Cal.com OK → cancelBooking compensação', async () => {
    const client = makeClient()
    const { supabase } = buildSb({
      doctor: baseDoctor,
      patient: basePatientWithEmail,
      insertApptError: { message: 'unique violation' },
    })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    await expect(getExec(buildConfirmAppointmentTool(ctx))(baseInput)).rejects.toThrow(
      /db insert failed/,
    )
    expect(client.cancelBooking).toHaveBeenCalledWith('cal-uid-123', expect.stringMatching(/rollback/i))
  })

  it('doctor não encontrado → ok:false, sem chamar Cal.com', async () => {
    const client = makeClient()
    const { supabase } = buildSb({ doctor: null, patient: basePatientWithEmail })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    const result = (await getExec(buildConfirmAppointmentTool(ctx))(baseInput)) as {
      ok: false
      error: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toBe('doctor_not_found')
    expect(client.createBooking).not.toHaveBeenCalled()
  })

  it('patient não encontrado (cross-tenant) → ok:false', async () => {
    const client = makeClient()
    const { supabase } = buildSb({ doctor: baseDoctor, patient: null })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    const result = (await getExec(buildConfirmAppointmentTool(ctx))(baseInput)) as {
      ok: false
      error: string
    }
    expect(result.error).toBe('patient_not_found')
    expect(client.createBooking).not.toHaveBeenCalled()
  })

  it('calcomClient ausente → ok:false calcom_not_configured', async () => {
    const { supabase } = buildSb({ doctor: baseDoctor, patient: basePatientWithEmail })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
    }
    const result = (await getExec(buildConfirmAppointmentTool(ctx))(baseInput)) as {
      ok: false
      error: string
    }
    expect(result.error).toBe('calcom_not_configured')
  })

  it('rollback graceful: cancelBooking compensação throw → propaga erro original (não loop)', async () => {
    const client = makeClient()
    client.cancelBooking = vi.fn().mockRejectedValue(new Error('cal.com 500'))
    const { supabase } = buildSb({
      doctor: baseDoctor,
      patient: basePatientWithEmail,
      insertApptError: { message: 'unique violation' },
    })
    const ctx: ToolContext = {
      clinicId: 'clinic-A',
      conversationId: 'conv-1',
      supabase: supabase as never,
      calcomClient: client,
    }
    await expect(getExec(buildConfirmAppointmentTool(ctx))(baseInput)).rejects.toThrow(
      /db insert failed/,
    )
    // Compensação tentada mas falhou — não loop, propaga erro original.
    expect(client.cancelBooking).toHaveBeenCalledOnce()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processCalcomEventHandler,
  type ProcessCalcomEventDeps,
  type ProcessCalcomEventEvent,
  type StepLike,
} from '../process-calcom-event';

const fakeStep: StepLike = {
  run: <T>(_name: string, fn: () => Promise<T>) => fn(),
};

function makeDeps(overrides: Partial<ProcessCalcomEventDeps> = {}): ProcessCalcomEventDeps {
  return {
    recordEvent: vi.fn().mockResolvedValue({ id: 'evt-1', alreadyProcessed: false }),
    findAppointment: vi.fn().mockResolvedValue(null),
    findPatientByEmail: vi.fn().mockResolvedValue(null),
    upsertAppointment: vi.fn().mockResolvedValue({ id: 'appt-NEW' }),
    updateAppointmentStatus: vi.fn().mockResolvedValue(undefined),
    updateAppointmentReschedule: vi.fn().mockResolvedValue(undefined),
    markEventProcessed: vi.fn().mockResolvedValue(undefined),
    markEventFailed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const baseEvent = (overrides: Partial<ProcessCalcomEventEvent['data']> = {}): ProcessCalcomEventEvent => ({
  data: {
    clinicId: 'clinic-A',
    integrationId: 'integ-1',
    triggerEvent: 'BOOKING_CREATED',
    uid: 'cal-uid-1',
    payload: {
      uid: 'cal-uid-1',
      bookingId: 999,
      eventTypeId: 42,
      startTime: '2026-06-01T10:00:00Z',
      endTime: '2026-06-01T10:30:00Z',
      attendees: [{ email: 'p@x.com', name: 'João' }],
    },
    ...overrides,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processCalcomEventHandler', () => {
  it('BOOKING_CREATED novo: UPSERT appointments + lookup patient by email', async () => {
    const deps = makeDeps({
      findPatientByEmail: vi.fn().mockResolvedValue({ id: 'pat-1' }),
    });
    const result = await processCalcomEventHandler(baseEvent(), fakeStep, deps);

    expect(result.action).toBe('inserted');
    expect(result.appointmentId).toBe('appt-NEW');
    expect(deps.findPatientByEmail).toHaveBeenCalledWith({
      clinicId: 'clinic-A',
      email: 'p@x.com',
    });
    expect(deps.upsertAppointment).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: 'clinic-A',
        calcomUid: 'cal-uid-1',
        patientId: 'pat-1',
      }),
    );
    expect(deps.markEventProcessed).toHaveBeenCalledWith({
      eventId: 'evt-1',
      appointmentId: 'appt-NEW',
    });
  });

  it('BOOKING_CREATED paciente sem email match: appointment criado com patientId=null', async () => {
    const deps = makeDeps({ findPatientByEmail: vi.fn().mockResolvedValue(null) });
    const result = await processCalcomEventHandler(baseEvent(), fakeStep, deps);
    expect(result.action).toBe('inserted');
    expect(deps.upsertAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: null }),
    );
  });

  it('BOOKING_CREATED sem attendees: cria appointment com patientId=null e sem lookup', async () => {
    const deps = makeDeps();
    const evt = baseEvent({
      payload: {
        uid: 'cal-uid-1',
        bookingId: 999,
        eventTypeId: 42,
        startTime: '2026-06-01T10:00:00Z',
        endTime: '2026-06-01T10:30:00Z',
        attendees: [],
      },
    });
    const result = await processCalcomEventHandler(evt, fakeStep, deps);
    expect(result.action).toBe('inserted');
    expect(deps.findPatientByEmail).not.toHaveBeenCalled();
    expect(deps.upsertAppointment).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: null }),
    );
  });

  it('BOOKING_CREATED replay (alreadyProcessed) → skipped sem chamar upsert', async () => {
    const deps = makeDeps({
      recordEvent: vi.fn().mockResolvedValue({ id: 'evt-1', alreadyProcessed: true }),
    });
    const result = await processCalcomEventHandler(baseEvent(), fakeStep, deps);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('already_processed');
    expect(deps.upsertAppointment).not.toHaveBeenCalled();
    // Idempotência forte: nenhuma escrita secundária no replay.
    expect(deps.markEventProcessed).not.toHaveBeenCalled();
    expect(deps.markEventFailed).not.toHaveBeenCalled();
  });

  it('BOOKING_CONFIRMED: UPDATE status=confirmed', async () => {
    const deps = makeDeps({
      findAppointment: vi.fn().mockResolvedValue({
        id: 'appt-1',
        clinic_id: 'clinic-A',
        status: 'scheduled',
      }),
    });
    const result = await processCalcomEventHandler(
      baseEvent({ triggerEvent: 'BOOKING_CONFIRMED' }),
      fakeStep,
      deps,
    );
    expect(result.action).toBe('updated');
    expect(deps.updateAppointmentStatus).toHaveBeenCalledWith({
      appointmentId: 'appt-1',
      newStatus: 'confirmed',
    });
  });

  it('BOOKING_CONFIRMED sem match → no_match (idempotência: não throw)', async () => {
    const deps = makeDeps({ findAppointment: vi.fn().mockResolvedValue(null) });
    const result = await processCalcomEventHandler(
      baseEvent({ triggerEvent: 'BOOKING_CONFIRMED' }),
      fakeStep,
      deps,
    );
    expect(result.action).toBe('no_match');
    expect(deps.updateAppointmentStatus).not.toHaveBeenCalled();
    // markEventProcessed é chamado mesmo no no_match — evita reprocessamento
    // futuro quando o appointment não existe (Cal.com pode mandar
    // BOOKING_CONFIRMED pra booking criado fora do Medina).
    expect(deps.markEventProcessed).toHaveBeenCalledWith({
      eventId: 'evt-1',
      appointmentId: undefined,
    });
  });

  it('BOOKING_RESCHEDULED sem rescheduleUid: fallback lookup por uid', async () => {
    const deps = makeDeps({
      findAppointment: vi.fn().mockResolvedValue({
        id: 'appt-1',
        clinic_id: 'clinic-A',
        status: 'scheduled',
      }),
    });
    const evt = baseEvent({
      triggerEvent: 'BOOKING_RESCHEDULED',
      uid: 'NEW-uid',
      payload: {
        uid: 'NEW-uid',
        bookingId: 1000,
        startTime: '2026-06-02T10:00:00Z',
        endTime: '2026-06-02T10:30:00Z',
        attendees: [],
      },
    });
    await processCalcomEventHandler(evt, fakeStep, deps);
    // Sem rescheduleUid → cai no fallback `uid` próprio do payload.
    expect(deps.findAppointment).toHaveBeenCalledWith({
      clinicId: 'clinic-A',
      calcomUid: 'NEW-uid',
    });
  });

  it('BOOKING_RESCHEDULED: lookup por rescheduleUid + UPDATE start/end + new uid', async () => {
    const deps = makeDeps({
      findAppointment: vi.fn().mockResolvedValue({
        id: 'appt-1',
        clinic_id: 'clinic-A',
        status: 'scheduled',
      }),
    });
    const evt = baseEvent({
      triggerEvent: 'BOOKING_RESCHEDULED',
      uid: 'NEW-uid',
      payload: {
        uid: 'NEW-uid',
        rescheduleUid: 'OLD-uid',
        bookingId: 1000,
        startTime: '2026-06-02T10:00:00Z',
        endTime: '2026-06-02T10:30:00Z',
        attendees: [],
      },
    });
    const result = await processCalcomEventHandler(evt, fakeStep, deps);
    expect(result.action).toBe('updated');
    expect(deps.findAppointment).toHaveBeenCalledWith({
      clinicId: 'clinic-A',
      calcomUid: 'OLD-uid',
    });
    expect(deps.updateAppointmentReschedule).toHaveBeenCalledWith({
      appointmentId: 'appt-1',
      newStartAt: '2026-06-02T10:00:00Z',
      newEndAt: '2026-06-02T10:30:00Z',
      newCalcomUid: 'NEW-uid',
      newBookingId: 1000,
    });
  });

  it('BOOKING_CANCELLED: RPC transition_appointment_status com cancelled_by_patient', async () => {
    const deps = makeDeps({
      findAppointment: vi.fn().mockResolvedValue({
        id: 'appt-1',
        clinic_id: 'clinic-A',
        status: 'scheduled',
      }),
    });
    const evt = baseEvent({
      triggerEvent: 'BOOKING_CANCELLED',
      payload: { uid: 'cal-uid-1', cancellationReason: 'paciente desistiu', attendees: [] },
    });
    const result = await processCalcomEventHandler(evt, fakeStep, deps);
    expect(result.action).toBe('updated');
    expect(deps.updateAppointmentStatus).toHaveBeenCalledWith({
      appointmentId: 'appt-1',
      newStatus: 'cancelled_by_patient',
      reason: 'paciente desistiu',
    });
  });

  it('Cross-tenant: appointment.clinic_id != event.clinicId → throw', async () => {
    const deps = makeDeps({
      findAppointment: vi.fn().mockResolvedValue({
        id: 'appt-1',
        clinic_id: 'clinic-OTHER',
        status: 'scheduled',
      }),
    });
    await expect(
      processCalcomEventHandler(
        baseEvent({ triggerEvent: 'BOOKING_CONFIRMED' }),
        fakeStep,
        deps,
      ),
    ).rejects.toThrow(/cross-tenant/);
    expect(deps.updateAppointmentStatus).not.toHaveBeenCalled();
  });

  it('error mid-handler → markEventFailed (sem processed_at) + re-throw original', async () => {
    const deps = makeDeps({
      findAppointment: vi.fn().mockResolvedValue({
        id: 'appt-1',
        clinic_id: 'clinic-A',
        status: 'scheduled',
      }),
      updateAppointmentStatus: vi.fn().mockRejectedValue(new Error('rpc failed')),
    });
    await expect(
      processCalcomEventHandler(
        baseEvent({ triggerEvent: 'BOOKING_CONFIRMED' }),
        fakeStep,
        deps,
      ),
    ).rejects.toThrow('rpc failed');
    expect(deps.markEventFailed).toHaveBeenCalledWith({
      eventId: 'evt-1',
      errorMessage: expect.stringContaining('rpc failed'),
    });
    expect(deps.markEventProcessed).not.toHaveBeenCalled();
  });

  it('markEventFailed throw não mascarar a exception original', async () => {
    const deps = makeDeps({
      findAppointment: vi.fn().mockResolvedValue({
        id: 'appt-1',
        clinic_id: 'clinic-A',
        status: 'scheduled',
      }),
      updateAppointmentStatus: vi.fn().mockRejectedValue(new Error('rpc failed')),
      markEventFailed: vi.fn().mockRejectedValue(new Error('UPDATE failed')),
    });
    await expect(
      processCalcomEventHandler(
        baseEvent({ triggerEvent: 'BOOKING_CONFIRMED' }),
        fakeStep,
        deps,
      ),
    ).rejects.toThrow('rpc failed');
  });

  it('happy path: markEventProcessed sem errorMessage', async () => {
    const deps = makeDeps({
      findPatientByEmail: vi.fn().mockResolvedValue({ id: 'pat-1' }),
    });
    await processCalcomEventHandler(baseEvent(), fakeStep, deps);
    expect(deps.markEventProcessed).toHaveBeenCalledWith({
      eventId: 'evt-1',
      appointmentId: 'appt-NEW',
    });
    expect(deps.markEventFailed).not.toHaveBeenCalled();
  });
});

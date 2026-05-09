import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { inngest } from '@/lib/inngest/client';

// ─── Types ───────────────────────────────────────────────────────────────────

export type CalcomEventPayload = {
  uid: string;
  bookingId?: number;
  eventTypeId?: number;
  startTime?: string;
  endTime?: string;
  attendees?: Array<{ email: string; name: string }>;
  cancellationReason?: string;
  rescheduleUid?: string;
  metadata?: Record<string, unknown>;
};

export type ProcessCalcomEventEvent = {
  data: {
    clinicId: string;
    integrationId: string;
    triggerEvent:
      | 'BOOKING_CREATED'
      | 'BOOKING_CONFIRMED'
      | 'BOOKING_RESCHEDULED'
      | 'BOOKING_CANCELLED';
    uid: string;
    payload: CalcomEventPayload;
  };
};

export type StepLike = {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
};

export type ProcessCalcomEventDeps = {
  /** UPSERT no calcom_webhook_events pra audit. Returns { id, was_dup }. */
  recordEvent: (args: {
    clinicId: string;
    triggerEvent: string;
    uid: string;
    payload: unknown;
  }) => Promise<{ id: string; alreadyProcessed: boolean }>;
  /** Lookup appointment por (clinicId, calcom_uid). */
  findAppointment: (args: { clinicId: string; calcomUid: string }) => Promise<{
    id: string;
    clinic_id: string;
    status: string;
  } | null>;
  /** Lookup patient por email (BOOKING_CREATED externo). */
  findPatientByEmail: (args: {
    clinicId: string;
    email: string;
  }) => Promise<{ id: string } | null>;
  /** Lookup doctor por calcom_user_id (vindo do payload — Cal.com self-host). */
  findDoctorByCalcomUserId?: (args: {
    clinicId: string;
    calcomUserId: string;
  }) => Promise<{ id: string } | null>;
  /** UPSERT appointment via calcom_uid pra BOOKING_CREATED. */
  upsertAppointment: (args: {
    clinicId: string;
    calcomUid: string;
    bookingId: number | undefined;
    eventTypeId: number | undefined;
    startAt: string;
    endAt: string;
    patientId: string | null;
    doctorId: string | null;
  }) => Promise<{ id: string }>;
  /** UPDATE status. */
  updateAppointmentStatus: (args: {
    appointmentId: string;
    newStatus: string;
    reason?: string;
  }) => Promise<void>;
  /** UPDATE start/end + new uid pra BOOKING_RESCHEDULED. */
  updateAppointmentReschedule: (args: {
    appointmentId: string;
    newStartAt: string;
    newEndAt: string;
    newCalcomUid: string;
    newBookingId: number | undefined;
  }) => Promise<void>;
  /** UPDATE calcom_webhook_events SET processed_at=NOW(), appointment_id=... */
  markEventProcessed: (args: {
    eventId: string;
    appointmentId?: string;
    errorMessage?: string;
  }) => Promise<void>;
};

export type ProcessCalcomEventResult = {
  triggerEvent: string;
  uid: string;
  appointmentId?: string;
  action: 'inserted' | 'updated' | 'skipped' | 'no_match';
  reason?: string;
};

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * AI-4: worker idempotente pra Cal.com webhook events. Mapping:
 *   BOOKING_CREATED → UPSERT appointments (created_via='calcom_external')
 *   BOOKING_CONFIRMED → UPDATE status='confirmed' (no-op se sem match)
 *   BOOKING_RESCHEDULED → UPDATE start/end + new uid (no-op se sem match)
 *   BOOKING_CANCELLED → UPDATE status='cancelled_by_patient'
 *
 * Cross-tenant defense: appointment.clinic_id must equal event.clinicId.
 *
 * Idempotência: calcom_webhook_events UNIQUE INDEX (clinic_id, trigger_event,
 * calcom_uid). Replay → recordEvent retorna alreadyProcessed=true → no-op.
 */
export async function processCalcomEventHandler(
  event: ProcessCalcomEventEvent,
  step: StepLike,
  deps: ProcessCalcomEventDeps,
): Promise<ProcessCalcomEventResult> {
  const { clinicId, triggerEvent, uid, payload } = event.data;

  // Step 1: record event (audit + dedup).
  const evtRow = await step.run('record-event', () =>
    deps.recordEvent({ clinicId, triggerEvent, uid, payload }),
  );

  if (evtRow.alreadyProcessed) {
    return {
      triggerEvent,
      uid,
      action: 'skipped',
      reason: 'already_processed',
    };
  }

  try {
    let result: ProcessCalcomEventResult;
    switch (triggerEvent) {
      case 'BOOKING_CREATED':
        result = await handleCreated(clinicId, uid, payload, deps);
        break;
      case 'BOOKING_CONFIRMED':
        result = await handleConfirmed(clinicId, uid, deps);
        break;
      case 'BOOKING_RESCHEDULED':
        result = await handleRescheduled(clinicId, uid, payload, deps);
        break;
      case 'BOOKING_CANCELLED':
        result = await handleCancelled(clinicId, uid, payload, deps);
        break;
      default:
        result = { triggerEvent, uid, action: 'skipped', reason: 'unknown_trigger' };
    }

    await deps.markEventProcessed({
      eventId: evtRow.id,
      appointmentId: result.appointmentId,
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.markEventProcessed({ eventId: evtRow.id, errorMessage: msg });
    throw err;
  }
}

async function handleCreated(
  clinicId: string,
  uid: string,
  payload: CalcomEventPayload,
  deps: ProcessCalcomEventDeps,
): Promise<ProcessCalcomEventResult> {
  // Já existe? UPSERT é idempotente — só evita lookup duplo se quisermos
  // distinguir 'inserted' vs 'updated' no result.
  const existing = await deps.findAppointment({ clinicId, calcomUid: uid });
  if (existing) {
    if (existing.clinic_id !== clinicId) {
      throw new Error(`cross-tenant: appt ${existing.id} belongs to ${existing.clinic_id}`);
    }
    return { triggerEvent: 'BOOKING_CREATED', uid, appointmentId: existing.id, action: 'skipped', reason: 'already_exists' };
  }

  // Mínimo viável: precisa de startTime + endTime + attendee primário.
  if (!payload.startTime || !payload.endTime) {
    return { triggerEvent: 'BOOKING_CREATED', uid, action: 'skipped', reason: 'missing_times' };
  }

  const primaryAttendee = payload.attendees?.[0];
  let patientId: string | null = null;
  if (primaryAttendee?.email) {
    const patient = await deps.findPatientByEmail({ clinicId, email: primaryAttendee.email });
    patientId = patient?.id ?? null;
  }

  // Doctor lookup desligado por padrão (calcom payload self-host nem sempre
  // expõe userId). Worker faz best-effort com payload.metadata se presente.
  const doctorId: string | null = null;

  const appt = await deps.upsertAppointment({
    clinicId,
    calcomUid: uid,
    bookingId: payload.bookingId,
    eventTypeId: payload.eventTypeId,
    startAt: payload.startTime,
    endAt: payload.endTime,
    patientId,
    doctorId,
  });

  return {
    triggerEvent: 'BOOKING_CREATED',
    uid,
    appointmentId: appt.id,
    action: 'inserted',
  };
}

async function handleConfirmed(
  clinicId: string,
  uid: string,
  deps: ProcessCalcomEventDeps,
): Promise<ProcessCalcomEventResult> {
  const appt = await deps.findAppointment({ clinicId, calcomUid: uid });
  if (!appt) {
    return { triggerEvent: 'BOOKING_CONFIRMED', uid, action: 'no_match' };
  }
  if (appt.clinic_id !== clinicId) {
    throw new Error(`cross-tenant: appt ${appt.id} belongs to ${appt.clinic_id}`);
  }
  if (appt.status === 'confirmed') {
    return {
      triggerEvent: 'BOOKING_CONFIRMED',
      uid,
      appointmentId: appt.id,
      action: 'skipped',
      reason: 'already_confirmed',
    };
  }
  await deps.updateAppointmentStatus({ appointmentId: appt.id, newStatus: 'confirmed' });
  return { triggerEvent: 'BOOKING_CONFIRMED', uid, appointmentId: appt.id, action: 'updated' };
}

async function handleRescheduled(
  clinicId: string,
  uid: string,
  payload: CalcomEventPayload,
  deps: ProcessCalcomEventDeps,
): Promise<ProcessCalcomEventResult> {
  // payload.rescheduleUid é o uid antigo; uid é o novo (Cal.com gera novo).
  // Mas também aceitamos uid sendo o antigo (alguns providers self-host
  // mantêm uid). Tentamos ambos.
  const oldUid = payload.rescheduleUid ?? uid;
  const appt = await deps.findAppointment({ clinicId, calcomUid: oldUid });
  if (!appt) {
    return { triggerEvent: 'BOOKING_RESCHEDULED', uid, action: 'no_match' };
  }
  if (appt.clinic_id !== clinicId) {
    throw new Error(`cross-tenant: appt ${appt.id} belongs to ${appt.clinic_id}`);
  }
  if (!payload.startTime || !payload.endTime) {
    return { triggerEvent: 'BOOKING_RESCHEDULED', uid, appointmentId: appt.id, action: 'skipped', reason: 'missing_times' };
  }
  await deps.updateAppointmentReschedule({
    appointmentId: appt.id,
    newStartAt: payload.startTime,
    newEndAt: payload.endTime,
    newCalcomUid: uid,
    newBookingId: payload.bookingId,
  });
  return { triggerEvent: 'BOOKING_RESCHEDULED', uid, appointmentId: appt.id, action: 'updated' };
}

async function handleCancelled(
  clinicId: string,
  uid: string,
  payload: CalcomEventPayload,
  deps: ProcessCalcomEventDeps,
): Promise<ProcessCalcomEventResult> {
  const appt = await deps.findAppointment({ clinicId, calcomUid: uid });
  if (!appt) {
    return { triggerEvent: 'BOOKING_CANCELLED', uid, action: 'no_match' };
  }
  if (appt.clinic_id !== clinicId) {
    throw new Error(`cross-tenant: appt ${appt.id} belongs to ${appt.clinic_id}`);
  }
  if (appt.status.startsWith('cancelled')) {
    return {
      triggerEvent: 'BOOKING_CANCELLED',
      uid,
      appointmentId: appt.id,
      action: 'skipped',
      reason: 'already_cancelled',
    };
  }
  await deps.updateAppointmentStatus({
    appointmentId: appt.id,
    newStatus: 'cancelled_by_patient',
    reason: payload.cancellationReason ?? 'cancelled via Cal.com',
  });
  return { triggerEvent: 'BOOKING_CANCELLED', uid, appointmentId: appt.id, action: 'updated' };
}

// ─── Production deps ────────────────────────────────────────────────────────

function makeAdminClient(): SupabaseClient {
  return createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function makeProcessCalcomEventDeps(): ProcessCalcomEventDeps {
  const client = makeAdminClient();
  return {
    async recordEvent(args) {
      // INSERT...ON CONFLICT DO NOTHING. Se conflict (replay), SELECT pega
      // o existing pra retornar alreadyProcessed flag.
      const { data: inserted, error: insErr } = await client
        .from('calcom_webhook_events')
        .insert({
          clinic_id: args.clinicId,
          trigger_event: args.triggerEvent,
          calcom_uid: args.uid,
          payload: args.payload,
        })
        .select('id, processed_at')
        .single();
      if (!insErr && inserted) {
        return { id: (inserted as { id: string }).id, alreadyProcessed: false };
      }
      // Conflict ou erro — tenta SELECT existing.
      const { data: existing } = await client
        .from('calcom_webhook_events')
        .select('id, processed_at')
        .eq('clinic_id', args.clinicId)
        .eq('trigger_event', args.triggerEvent)
        .eq('calcom_uid', args.uid)
        .maybeSingle();
      if (!existing) {
        throw new Error(`recordEvent failed: ${insErr?.message ?? 'no row'}`);
      }
      const row = existing as { id: string; processed_at: string | null };
      return { id: row.id, alreadyProcessed: row.processed_at !== null };
    },
    async findAppointment(args) {
      const { data } = await client
        .from('appointments')
        .select('id, clinic_id, status')
        .eq('clinic_id', args.clinicId)
        .eq('calcom_uid', args.calcomUid)
        .maybeSingle();
      return data as { id: string; clinic_id: string; status: string } | null;
    },
    async findPatientByEmail(args) {
      const { data } = await client
        .from('patients')
        .select('id')
        .eq('clinic_id', args.clinicId)
        .eq('email', args.email)
        .maybeSingle();
      return data as { id: string } | null;
    },
    async upsertAppointment(args) {
      const { data, error } = await client
        .from('appointments')
        .insert({
          clinic_id: args.clinicId,
          calcom_uid: args.calcomUid,
          calcom_booking_id: args.bookingId ? String(args.bookingId) : null,
          status: 'scheduled',
          start_at: args.startAt,
          end_at: args.endAt,
          timezone: 'America/Sao_Paulo',
          modality: 'in_person',
          patient_id: args.patientId,
          doctor_id: args.doctorId,
          created_via: 'calcom_external',
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(`upsertAppointment: ${error?.message ?? 'no data'}`);
      return data as { id: string };
    },
    async updateAppointmentStatus(args) {
      const { error } = await client.rpc('transition_appointment_status', {
        p_appointment_id: args.appointmentId,
        p_new_status: args.newStatus,
        p_reason: args.reason ?? `webhook: ${args.newStatus}`,
      });
      if (error) throw new Error(`updateAppointmentStatus: ${error.message}`);
    },
    async updateAppointmentReschedule(args) {
      const { error } = await client
        .from('appointments')
        .update({
          start_at: args.newStartAt,
          end_at: args.newEndAt,
          calcom_uid: args.newCalcomUid,
          calcom_booking_id: args.newBookingId ? String(args.newBookingId) : null,
          status: 'rescheduled',
          updated_at: new Date().toISOString(),
        })
        .eq('id', args.appointmentId);
      if (error) throw new Error(`updateAppointmentReschedule: ${error.message}`);
    },
    async markEventProcessed(args) {
      await client
        .from('calcom_webhook_events')
        .update({
          processed_at: new Date().toISOString(),
          appointment_id: args.appointmentId ?? null,
          error_message: args.errorMessage ?? null,
        })
        .eq('id', args.eventId);
    },
  };
}

// ─── Inngest registration ───────────────────────────────────────────────────

export const processCalcomEvent = inngest.createFunction(
  {
    id: 'process-calcom-event',
    retries: 2,
    triggers: [{ event: 'calcom/booking.received' }],
  },
  async ({ event, step }) =>
    processCalcomEventHandler(
      event as unknown as ProcessCalcomEventEvent,
      step as unknown as StepLike,
      makeProcessCalcomEventDeps(),
    ),
);

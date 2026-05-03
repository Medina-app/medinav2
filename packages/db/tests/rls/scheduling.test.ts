import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic,
  cleanupAll,
  createTestAppointment,
  createTestClinic,
  createTestConversation,
  createTestDeal,
  createTestDoctor,
  createTestIntegration,
  createTestPatient,
  createTestPipeline,
  createTestPipelineStage,
  createTestUser,
  getRlsClient,
  getServiceClient,
} from './helpers/setup.js';

const sql = getServiceClient();
beforeAll(async () => { await cleanupAll(sql); });
afterAll(async () => { await cleanupAll(sql); await sql.end(); });

// ─── Cross-tenant isolation ────────────────────────────────────────────────────

describe('scheduling: cross-tenant isolation', () => {
  it('users only see doctors/appointments of their clinics', async () => {
    const cA = await createTestClinic(sql, 'Sched Iso A');
    const cB = await createTestClinic(sql, 'Sched Iso B');
    const uA = await createTestUser(sql);
    await addUserToClinic(sql, cA.id, uA.id);

    const dA = await createTestDoctor(sql, cA.id);
    const apptA = await createTestAppointment(sql, cA.id, dA.id);

    const dB = await createTestDoctor(sql, cB.id);
    await createTestAppointment(sql, cB.id, dB.id);

    const rls = getRlsClient(sql, uA.id);

    const doctors = await rls.query((tx) => tx<{ id: string }[]>`SELECT id FROM doctors`);
    expect(doctors.map((r) => r.id)).toEqual([dA.id]);

    const appts = await rls.query((tx) => tx<{ id: string }[]>`SELECT id FROM appointments`);
    expect(appts.map((r) => r.id)).toEqual([apptA.id]);
  });
});

// ─── doctors: permissions ─────────────────────────────────────────────────────

describe('doctors: permissions', () => {
  it('non-admin cannot insert doctor', async () => {
    const clinic = await createTestClinic(sql, 'Doctor Insert Denied');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    await expect(
      getRlsClient(sql, member.id).query((tx) =>
        tx`INSERT INTO doctors (clinic_id, full_name) VALUES (${clinic.id}, 'Dr Unauthorized')`,
      ),
    ).rejects.toThrow();
  });

  it('non-admin cannot update doctor', async () => {
    const clinic = await createTestClinic(sql, 'Doctor Update Denied');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const doctor = await createTestDoctor(sql, clinic.id);

    const rows = await getRlsClient(sql, member.id).query((tx) =>
      tx<{ id: string }[]>`
        UPDATE doctors SET full_name = 'Hacked' WHERE id = ${doctor.id} RETURNING id
      `,
    );
    expect(rows).toHaveLength(0);
  });

  it('members can read all doctors of their clinic', async () => {
    const clinic = await createTestClinic(sql, 'Doctor Read All');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const d1 = await createTestDoctor(sql, clinic.id, { fullName: 'Dr One' });
    const d2 = await createTestDoctor(sql, clinic.id, { fullName: 'Dr Two' });

    const rows = await getRlsClient(sql, member.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM doctors WHERE clinic_id = ${clinic.id}`,
    );
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([d1.id, d2.id]));
  });

  it('admin can insert doctor', async () => {
    const clinic = await createTestClinic(sql, 'Doctor Insert Admin');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');

    const rows = await getRlsClient(sql, admin.id).query((tx) =>
      tx<{ id: string }[]>`
        INSERT INTO doctors (clinic_id, full_name)
        VALUES (${clinic.id}, 'Dr Admin Created')
        RETURNING id
      `,
    );
    expect(rows[0]?.id).toBeDefined();
  });
});

// ─── appointments: permissions ────────────────────────────────────────────────

describe('appointments: permissions', () => {
  it('member can create appointment', async () => {
    const clinic = await createTestClinic(sql, 'Appt Create');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const doctor = await createTestDoctor(sql, clinic.id);
    const startAt = new Date(Date.now() + 86400000).toISOString();
    const endAt = new Date(Date.now() + 86400000 + 3600000).toISOString();

    const rows = await getRlsClient(sql, member.id).query((tx) =>
      tx<{ id: string }[]>`
        INSERT INTO appointments (clinic_id, doctor_id, start_at, end_at)
        VALUES (${clinic.id}, ${doctor.id}, ${startAt}, ${endAt})
        RETURNING id
      `,
    );
    expect(rows[0]?.id).toBeDefined();
  });

  it('member can update appointment', async () => {
    const clinic = await createTestClinic(sql, 'Appt Update');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const doctor = await createTestDoctor(sql, clinic.id);
    const appt = await createTestAppointment(sql, clinic.id, doctor.id);

    const rows = await getRlsClient(sql, member.id).query((tx) =>
      tx<{ id: string }[]>`
        UPDATE appointments SET notes = 'updated notes' WHERE id = ${appt.id} RETURNING id
      `,
    );
    expect(rows[0]?.id).toBe(appt.id);
  });

  it('members can read all appointments of their clinic', async () => {
    const clinic = await createTestClinic(sql, 'Appt Read All');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const doctor = await createTestDoctor(sql, clinic.id);
    const a1 = await createTestAppointment(sql, clinic.id, doctor.id);
    const a2 = await createTestAppointment(sql, clinic.id, doctor.id);

    const rows = await getRlsClient(sql, member.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM appointments WHERE clinic_id = ${clinic.id}`,
    );
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([a1.id, a2.id]));
  });

  it('non-admin cannot delete appointment', async () => {
    const clinic = await createTestClinic(sql, 'Appt Delete Denied');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const doctor = await createTestDoctor(sql, clinic.id);
    const appt = await createTestAppointment(sql, clinic.id, doctor.id);

    const rows = await getRlsClient(sql, member.id).query((tx) =>
      tx<{ id: string }[]>`DELETE FROM appointments WHERE id = ${appt.id} RETURNING id`,
    );
    expect(rows).toHaveLength(0);
  });
});

// ─── appointments: cross-tenant FK guards ────────────────────────────────────

describe('appointments: cross-tenant FK guards', () => {
  it('appointment.doctor_id must match same clinic', async () => {
    const cA = await createTestClinic(sql, 'Appt Doc FK A');
    const cB = await createTestClinic(sql, 'Appt Doc FK B');
    const dB = await createTestDoctor(sql, cB.id);
    const startAt = new Date(Date.now() + 86400000).toISOString();
    const endAt = new Date(Date.now() + 86400000 + 3600000).toISOString();

    await expect(
      sql`
        INSERT INTO appointments (clinic_id, doctor_id, start_at, end_at)
        VALUES (${cA.id}, ${dB.id}, ${startAt}, ${endAt})
      `,
    ).rejects.toThrow();
  });

  it('appointment.patient_id must match same clinic', async () => {
    const cA = await createTestClinic(sql, 'Appt Pat FK A');
    const cB = await createTestClinic(sql, 'Appt Pat FK B');
    const dA = await createTestDoctor(sql, cA.id);
    const patB = await createTestPatient(sql, cB.id);
    const startAt = new Date(Date.now() + 86400000).toISOString();
    const endAt = new Date(Date.now() + 86400000 + 3600000).toISOString();

    await expect(
      sql`
        INSERT INTO appointments (clinic_id, doctor_id, patient_id, start_at, end_at)
        VALUES (${cA.id}, ${dA.id}, ${patB.id}, ${startAt}, ${endAt})
      `,
    ).rejects.toThrow();
  });

  it('appointment.conversation_id must match same clinic (if NOT NULL)', async () => {
    const cA = await createTestClinic(sql, 'Appt Conv FK A');
    const cB = await createTestClinic(sql, 'Appt Conv FK B');
    const dA = await createTestDoctor(sql, cA.id);
    const intB = await createTestIntegration(sql, cB.id);
    const convB = await createTestConversation(sql, cB.id, intB.id);
    const startAt = new Date(Date.now() + 86400000).toISOString();
    const endAt = new Date(Date.now() + 86400000 + 3600000).toISOString();

    await expect(
      sql`
        INSERT INTO appointments (clinic_id, doctor_id, conversation_id, start_at, end_at)
        VALUES (${cA.id}, ${dA.id}, ${convB.id}, ${startAt}, ${endAt})
      `,
    ).rejects.toThrow();
  });

  it('appointment.deal_id must match same clinic (if NOT NULL)', async () => {
    const cA = await createTestClinic(sql, 'Appt Deal FK A');
    const cB = await createTestClinic(sql, 'Appt Deal FK B');
    const dA = await createTestDoctor(sql, cA.id);
    const pipB = await createTestPipeline(sql, cB.id);
    const stgB = await createTestPipelineStage(sql, cB.id, pipB.id);
    const dealB = await createTestDeal(sql, cB.id, pipB.id, stgB.id);
    const startAt = new Date(Date.now() + 86400000).toISOString();
    const endAt = new Date(Date.now() + 86400000 + 3600000).toISOString();

    await expect(
      sql`
        INSERT INTO appointments (clinic_id, doctor_id, deal_id, start_at, end_at)
        VALUES (${cA.id}, ${dA.id}, ${dealB.id}, ${startAt}, ${endAt})
      `,
    ).rejects.toThrow();
  });
});

// ─── appointment_reminders: cascade e validação ───────────────────────────────

describe('appointment_reminders: cascade and clinic validation', () => {
  it('reminders are deleted when appointment is deleted (ON DELETE CASCADE)', async () => {
    const clinic = await createTestClinic(sql, 'Reminder Cascade');
    const doctor = await createTestDoctor(sql, clinic.id);
    const appt = await createTestAppointment(sql, clinic.id, doctor.id);

    await sql`
      INSERT INTO appointment_reminders (appointment_id, clinic_id, channel, scheduled_at)
      VALUES (${appt.id}, ${clinic.id}, 'whatsapp', NOW() + INTERVAL '1 hour')
    `;

    await sql`DELETE FROM appointments WHERE id = ${appt.id}`;

    const reminders = await sql<{ id: string }[]>`
      SELECT id FROM appointment_reminders WHERE appointment_id = ${appt.id}
    `;
    expect(reminders).toHaveLength(0);
  });

  it('reminder.clinic_id must match appointment.clinic_id', async () => {
    const cA = await createTestClinic(sql, 'Reminder Clinic FK A');
    const cB = await createTestClinic(sql, 'Reminder Clinic FK B');
    const doctor = await createTestDoctor(sql, cA.id);
    const appt = await createTestAppointment(sql, cA.id, doctor.id);

    await expect(
      sql`
        INSERT INTO appointment_reminders (appointment_id, clinic_id, channel, scheduled_at)
        VALUES (${appt.id}, ${cB.id}, 'whatsapp', NOW() + INTERVAL '1 hour')
      `,
    ).rejects.toThrow();
  });

  it('members cannot insert reminder directly (service_role only for write)', async () => {
    const clinic = await createTestClinic(sql, 'Reminder Insert Denied');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const doctor = await createTestDoctor(sql, clinic.id);
    const appt = await createTestAppointment(sql, clinic.id, doctor.id);

    await expect(
      getRlsClient(sql, member.id).query((tx) =>
        tx`
          INSERT INTO appointment_reminders (appointment_id, clinic_id, channel, scheduled_at)
          VALUES (${appt.id}, ${clinic.id}, 'whatsapp', NOW() + INTERVAL '1 hour')
        `,
      ),
    ).rejects.toThrow();
  });
});

// ─── audit log automático em mudanças de status ───────────────────────────────

describe('appointment: audit log on status change', () => {
  it('audit log entry is created when appointment status changes', async () => {
    const clinic = await createTestClinic(sql, 'Audit Status');
    const doctor = await createTestDoctor(sql, clinic.id);
    const appt = await createTestAppointment(sql, clinic.id, doctor.id);

    await sql`UPDATE appointments SET status = 'confirmed' WHERE id = ${appt.id}`;

    type AuditRow = { action: string; resource: string; metadata: Record<string, unknown> };
    const logs = await sql<AuditRow[]>`
      SELECT action, resource, metadata
      FROM audit_logs
      WHERE resource_id = ${appt.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(logs[0]?.action).toBe('appointment.status_changed');
    expect(logs[0]?.resource).toBe('appointments');
    expect((logs[0]?.metadata as { before?: { status?: string } })?.before?.status).toBe('scheduled');
    expect((logs[0]?.metadata as { after?: { status?: string } })?.after?.status).toBe('confirmed');
  });
});

// ─── transition_appointment_status ───────────────────────────────────────────

describe('transition_appointment_status', () => {
  it('valid transitions work: scheduled → confirmed → in_progress → completed', async () => {
    const clinic = await createTestClinic(sql, 'Transition Valid');
    const doctor = await createTestDoctor(sql, clinic.id);
    const appt = await createTestAppointment(sql, clinic.id, doctor.id);

    await sql`SELECT transition_appointment_status(${appt.id}, 'confirmed')`;
    const [after1] = await sql<{ status: string; confirmed_at: string | null }[]>`
      SELECT status, confirmed_at FROM appointments WHERE id = ${appt.id}
    `;
    expect(after1?.status).toBe('confirmed');
    expect(after1?.confirmed_at).not.toBeNull();

    await sql`SELECT transition_appointment_status(${appt.id}, 'in_progress')`;
    await sql`SELECT transition_appointment_status(${appt.id}, 'completed')`;

    const [after3] = await sql<{ status: string; completed_at: string | null }[]>`
      SELECT status, completed_at FROM appointments WHERE id = ${appt.id}
    `;
    expect(after3?.status).toBe('completed');
    expect(after3?.completed_at).not.toBeNull();
  });

  it('invalid transition raises exception', async () => {
    const clinic = await createTestClinic(sql, 'Transition Invalid');
    const doctor = await createTestDoctor(sql, clinic.id);
    const appt = await createTestAppointment(sql, clinic.id, doctor.id);

    await expect(
      sql`SELECT transition_appointment_status(${appt.id}, 'completed')`,
    ).rejects.toThrow('Invalid appointment status transition');
  });

  it('terminal status cannot be transitioned further', async () => {
    const clinic = await createTestClinic(sql, 'Transition Terminal');
    const doctor = await createTestDoctor(sql, clinic.id);
    const appt = await createTestAppointment(sql, clinic.id, doctor.id);

    await sql`SELECT transition_appointment_status(${appt.id}, 'confirmed')`;
    await sql`SELECT transition_appointment_status(${appt.id}, 'in_progress')`;
    await sql`SELECT transition_appointment_status(${appt.id}, 'completed')`;

    await expect(
      sql`SELECT transition_appointment_status(${appt.id}, 'confirmed')`,
    ).rejects.toThrow('Invalid appointment status transition');
  });

  it('cancelling appointment cancels all scheduled reminders', async () => {
    const clinic = await createTestClinic(sql, 'Cancel Reminders');
    const doctor = await createTestDoctor(sql, clinic.id);
    const appt = await createTestAppointment(sql, clinic.id, doctor.id);

    await sql`
      INSERT INTO appointment_reminders (appointment_id, clinic_id, channel, scheduled_at)
      VALUES
        (${appt.id}, ${clinic.id}, 'whatsapp', NOW() + INTERVAL '1 hour'),
        (${appt.id}, ${clinic.id}, 'email',    NOW() + INTERVAL '2 hours')
    `;

    await sql`SELECT transition_appointment_status(${appt.id}, 'cancelled_by_patient', 'paciente cancelou')`;

    const reminders = await sql<{ status: string }[]>`
      SELECT status FROM appointment_reminders WHERE appointment_id = ${appt.id}
    `;
    expect(reminders.length).toBe(2);
    expect(reminders.every((r) => r.status === 'cancelled')).toBe(true);

    const [row] = await sql<{ cancelled_at: string | null; cancellation_reason: string | null }[]>`
      SELECT cancelled_at, cancellation_reason FROM appointments WHERE id = ${appt.id}
    `;
    expect(row?.cancelled_at).not.toBeNull();
    expect(row?.cancellation_reason).toBe('paciente cancelou');
  });
});

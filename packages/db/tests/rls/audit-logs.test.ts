import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic,
  cleanupAll,
  createTestClinic,
  createTestUser,
  getRlsClient,
  getServiceClient,
} from './helpers/setup.js';

const sql = getServiceClient();

beforeAll(async () => {
  await cleanupAll(sql);
});

afterAll(async () => {
  await cleanupAll(sql);
  await sql.end();
});

async function seedAuditLog(clinicId: string, userId: string): Promise<void> {
  await sql`
    INSERT INTO audit_logs (clinic_id, user_id, action, resource)
    VALUES (${clinicId}, ${userId}, 'test_action', 'test_resource')
  `;
}

describe('audit_logs: non-admin cannot read', () => {
  it('plain member sees 0 audit log rows', async () => {
    const clinic = await createTestClinic(sql, 'Audit Member');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    await seedAuditLog(clinic.id, member.id);

    const client = getRlsClient(sql, member.id);
    const rows = await client.query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM audit_logs WHERE clinic_id = ${clinic.id}`,
    );
    expect(rows).toHaveLength(0);
  });

  it('admin can read audit logs', async () => {
    const clinic = await createTestClinic(sql, 'Audit Admin');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');
    await seedAuditLog(clinic.id, admin.id);

    const client = getRlsClient(sql, admin.id);
    const rows = await client.query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM audit_logs WHERE clinic_id = ${clinic.id}`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('audit_logs: tenant isolation', () => {
  it('admin of clinic A cannot see audit logs of clinic B', async () => {
    const clinicA = await createTestClinic(sql, 'Audit Isolation A');
    const clinicB = await createTestClinic(sql, 'Audit Isolation B');
    const adminA = await createTestUser(sql);
    const userB = await createTestUser(sql);
    await addUserToClinic(sql, clinicA.id, adminA.id, 'admin');
    await addUserToClinic(sql, clinicB.id, userB.id, 'member');
    await seedAuditLog(clinicA.id, adminA.id);
    await seedAuditLog(clinicB.id, userB.id);

    const client = getRlsClient(sql, adminA.id);
    const rows = await client.query((tx) =>
      tx<{ clinic_id: string }[]>`SELECT clinic_id FROM audit_logs`,
    );

    expect(rows.every((r) => r.clinic_id === clinicA.id)).toBe(true);
  });
});

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

describe('clinics: tenant isolation', () => {
  it('member of clinic A cannot see clinic B', async () => {
    const clinicA = await createTestClinic(sql, 'Isolation A');
    const clinicB = await createTestClinic(sql, 'Isolation B');
    const user = await createTestUser(sql);
    await addUserToClinic(sql, clinicA.id, user.id, 'member');

    const client = getRlsClient(sql, user.id);
    const rows = await client.query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM clinics WHERE deleted_at IS NULL`,
    );

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(clinicA.id);
    expect(ids).not.toContain(clinicB.id);
  });
});

describe('clinics: soft delete', () => {
  it('soft-deleted clinic is invisible to its own members', async () => {
    const clinic = await createTestClinic(sql, 'SoftDelete Test');
    const user = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, user.id, 'member');

    await sql`UPDATE clinics SET deleted_at = NOW() WHERE id = ${clinic.id}`;

    const client = getRlsClient(sql, user.id);
    const rows = await client.query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM clinics WHERE deleted_at IS NULL`,
    );

    expect(rows.map((r) => r.id)).not.toContain(clinic.id);
  });
});

describe('clinics: role-based update', () => {
  it('owner can update clinic name', async () => {
    const clinic = await createTestClinic(sql, 'Update Owner');
    const owner = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, owner.id, 'owner');

    const client = getRlsClient(sql, owner.id);
    await expect(
      client.query((tx) =>
        tx`UPDATE clinics SET name = 'Updated' WHERE id = ${clinic.id}`,
      ),
    ).resolves.not.toThrow();
  });

  it('member cannot update clinic name (RLS silently blocks — 0 rows)', async () => {
    const clinic = await createTestClinic(sql, 'Update Member');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    const client = getRlsClient(sql, member.id);
    const result = await client.query((tx) =>
      tx<{ id: string }[]>`
        UPDATE clinics SET name = 'Hacked' WHERE id = ${clinic.id} RETURNING id
      `,
    );
    expect(result).toHaveLength(0);
  });
});

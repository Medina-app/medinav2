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

describe('clinic_members: cross-tenant isolation', () => {
  it('user of clinic A cannot see members of clinic B', async () => {
    const clinicA = await createTestClinic(sql, 'Members A');
    const clinicB = await createTestClinic(sql, 'Members B');
    const userA = await createTestUser(sql);
    const userB = await createTestUser(sql);
    await addUserToClinic(sql, clinicA.id, userA.id, 'member');
    await addUserToClinic(sql, clinicB.id, userB.id, 'member');

    const client = getRlsClient(sql, userA.id);
    const rows = await client.query((tx) =>
      tx<{ user_id: string }[]>`
        SELECT user_id FROM clinic_members WHERE deleted_at IS NULL
      `,
    );

    const userIds = rows.map((r) => r.user_id);
    expect(userIds).toContain(userA.id);
    expect(userIds).not.toContain(userB.id);
  });
});

describe('clinic_members: role permissions', () => {
  it('owner can add a new member', async () => {
    const clinic = await createTestClinic(sql, 'Role Add');
    const owner = await createTestUser(sql);
    const newUser = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, owner.id, 'owner');

    const client = getRlsClient(sql, owner.id);
    await expect(
      client.query((tx) =>
        tx`
          INSERT INTO clinic_members (clinic_id, user_id, role)
          VALUES (${clinic.id}, ${newUser.id}, 'member')
        `,
      ),
    ).resolves.not.toThrow();
  });

  it('plain member cannot add another member', async () => {
    const clinic = await createTestClinic(sql, 'Role Block');
    const member = await createTestUser(sql);
    const stranger = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    const client = getRlsClient(sql, member.id);
    await expect(
      client.query((tx) =>
        tx`
          INSERT INTO clinic_members (clinic_id, user_id, role)
          VALUES (${clinic.id}, ${stranger.id}, 'member')
        `,
      ),
    ).rejects.toThrow();
  });

  it('enforce_at_least_one_owner blocks soft-deleting the last owner', async () => {
    const clinic = await createTestClinic(sql, 'Last Owner');
    const owner = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, owner.id, 'owner');

    await expect(
      sql`
        UPDATE clinic_members
        SET deleted_at = NOW()
        WHERE clinic_id = ${clinic.id} AND user_id = ${owner.id}
      `,
    ).rejects.toThrow('clinic must have at least one owner');
  });
});

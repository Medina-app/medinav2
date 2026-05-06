import { afterAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic,
  createTestClinic,
  createTestUser,
  deleteTestClinic,
  getRlsClient,
  getServiceClient,
} from './helpers/setup.js';

const sql = getServiceClient();
const createdClinics: string[] = [];
async function makeClinic(name: string) {
  const c = await createTestClinic(sql, name);
  createdClinics.push(c.id);
  return c;
}

afterAll(async () => {
  await Promise.all(createdClinics.map((id) => deleteTestClinic(sql, id)));
  await sql.end();
});

describe('clinic_members: cross-tenant isolation', () => {
  it('user of clinic A cannot see members of clinic B', async () => {
    const clinicA = await makeClinic('Members A');
    const clinicB = await makeClinic('Members B');
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
    const clinic = await makeClinic('Role Add');
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
    const clinic = await makeClinic('Role Block');
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
    const clinic = await makeClinic('Last Owner');
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

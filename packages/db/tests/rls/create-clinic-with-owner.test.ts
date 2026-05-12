import { describe, it, expect, afterAll } from 'vitest';
import {
  getServiceClient,
  createTestUser,
  deleteTestUser,
  deleteTestClinic,
} from './helpers/setup.js';

const sql = getServiceClient();
const createdUserIds: string[] = [];
const createdClinicIds: string[] = [];

afterAll(async () => {
  await Promise.all(createdClinicIds.map((id) => deleteTestClinic(sql, id)));
  await Promise.all(createdUserIds.map((id) => deleteTestUser(sql, id)));
  await sql.end();
});

describe('create_clinic_with_owner RPC (PR-D #10)', () => {
  it('cria clinic + clinic_members(owner) em transação única', async () => {
    const user = await createTestUser(sql);
    createdUserIds.push(user.id);
    const slug = `pr-d-rpc-ok-${Date.now()}`;

    const [row] = await sql<{ id: string; slug: string }[]>`
      SELECT * FROM create_clinic_with_owner(
        ${'Clínica RPC Test'}::text,
        ${slug}::text,
        ${user.id}::uuid
      )
    `;
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row?.slug).toBe(slug);
    if (row?.id) createdClinicIds.push(row.id);

    const memberRows = await sql<{ role: string }[]>`
      SELECT role FROM clinic_members
      WHERE clinic_id = ${row!.id} AND user_id = ${user.id}
    `;
    expect(memberRows[0]?.role).toBe('owner');
  });

  it('rejeita slug duplicado e não deixa clinic órfã (transação atomica)', async () => {
    const user = await createTestUser(sql);
    createdUserIds.push(user.id);
    const slug = `pr-d-dup-${Date.now()}`;

    const [first] = await sql<{ id: string }[]>`
      SELECT id FROM create_clinic_with_owner(${'First'}::text, ${slug}::text, ${user.id}::uuid)
    `;
    createdClinicIds.push(first!.id);

    await expect(sql`
      SELECT create_clinic_with_owner(${'Second'}::text, ${slug}::text, ${user.id}::uuid)
    `).rejects.toThrow(/duplicate key|already exists|unique/i);

    const count = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM clinics WHERE slug = ${slug}
    `;
    expect(count[0]?.c).toBe('1');
  });

  it('rejeita user_id inexistente (FK violation), sem clinic órfã', async () => {
    const fakeUserId = '00000000-0000-0000-0000-000000000099';
    const slug = `pr-d-nouser-${Date.now()}`;

    await expect(sql`
      SELECT create_clinic_with_owner(${'NoUser'}::text, ${slug}::text, ${fakeUserId}::uuid)
    `).rejects.toThrow(/foreign key|violates/i);

    const count = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM clinics WHERE slug = ${slug}
    `;
    expect(count[0]?.c).toBe('0');
  });

  it('REVOKE de PUBLIC/anon/authenticated — só service_role executa', async () => {
    const rows = await sql<{ grantee: string }[]>`
      SELECT grantee FROM information_schema.routine_privileges
      WHERE routine_name = 'create_clinic_with_owner' AND routine_schema = 'public'
    `;
    const grantees = new Set(rows.map((r) => r.grantee));
    expect(grantees.has('service_role')).toBe(true);
    expect(grantees.has('anon')).toBe(false);
    expect(grantees.has('authenticated')).toBe(false);
  });
});

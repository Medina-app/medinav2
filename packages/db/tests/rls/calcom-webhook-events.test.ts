import { describe, it, expect, afterAll } from 'vitest';
import {
  getServiceClient,
  createTestClinic,
  createTestUser,
  addUserToClinic,
  getRlsClient,
  deleteTestClinic,
  deleteTestUser,
} from './helpers/setup.js';

const sql = getServiceClient();
const createdClinicIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  for (const id of createdClinicIds) {
    try {
      await sql`DELETE FROM calcom_webhook_events WHERE clinic_id = ${id}`;
    } catch {
      /* swallow */
    }
  }
  await Promise.all(createdClinicIds.map((id) => deleteTestClinic(sql, id)));
  await Promise.all(createdUserIds.map((id) => deleteTestUser(sql, id)));
  await sql.end();
});

async function makeClinic(name: string): Promise<{ id: string }> {
  const c = await createTestClinic(sql, name);
  createdClinicIds.push(c.id);
  return c;
}

async function makeUser(): Promise<{ id: string }> {
  const u = await createTestUser(sql);
  createdUserIds.push(u.id);
  return u;
}

describe('AI-4: calcom_webhook_events table + RLS', () => {
  it('1. service_role pode INSERT (worker path)', async () => {
    const c = await makeClinic('Calcom-WE-Insert');
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO calcom_webhook_events (clinic_id, trigger_event, calcom_uid, payload)
      VALUES (${c.id}, 'BOOKING_CREATED', 'uid-1', '{"hello":"world"}'::jsonb)
      RETURNING id
    `;
    expect(row?.id).toBeDefined();
  });

  it('2. CHECK rejeita trigger_event fora do enum', async () => {
    const c = await makeClinic('Calcom-WE-Check');
    await expect(sql`
      INSERT INTO calcom_webhook_events (clinic_id, trigger_event, payload)
      VALUES (${c.id}, 'BOOKING_INVALID', '{}'::jsonb)
    `).rejects.toThrow(/check constraint|trigger_event/i);
  });

  it('3. dedup UNIQUE INDEX bloqueia replay com mesmo (clinic,trigger,uid)', async () => {
    const c = await makeClinic('Calcom-WE-Dedup');
    await sql`
      INSERT INTO calcom_webhook_events (clinic_id, trigger_event, calcom_uid, payload)
      VALUES (${c.id}, 'BOOKING_CREATED', 'uid-dup', '{}'::jsonb)
    `;
    await expect(sql`
      INSERT INTO calcom_webhook_events (clinic_id, trigger_event, calcom_uid, payload)
      VALUES (${c.id}, 'BOOKING_CREATED', 'uid-dup', '{}'::jsonb)
    `).rejects.toThrow(/duplicate|unique/i);
  });

  it('4. members podem SELECT events da própria clinic; cross-tenant NÃO', async () => {
    const cA = await makeClinic('Calcom-WE-A');
    const cB = await makeClinic('Calcom-WE-B');
    const userA = await makeUser();
    await addUserToClinic(sql, cA.id, userA.id, 'member');

    await sql`
      INSERT INTO calcom_webhook_events (clinic_id, trigger_event, calcom_uid, payload)
      VALUES
        (${cA.id}, 'BOOKING_CREATED', 'uid-A', '{}'::jsonb),
        (${cB.id}, 'BOOKING_CREATED', 'uid-B', '{}'::jsonb)
    `;

    const rows = await getRlsClient(sql, userA.id).query((tx) =>
      tx<{ clinic_id: string }[]>`SELECT clinic_id FROM calcom_webhook_events`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.clinic_id === cA.id)).toBe(true);
  });
});

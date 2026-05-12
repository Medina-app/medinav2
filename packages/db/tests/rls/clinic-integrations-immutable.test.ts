import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  getServiceClient,
  createTestClinic,
  createTestIntegration,
  deleteTestClinic,
  ensureVaultMasterKey,
} from './helpers/setup.js';

const sql = getServiceClient();
const createdClinics: string[] = [];

beforeAll(async () => {
  await ensureVaultMasterKey(sql);
});

afterAll(async () => {
  await Promise.all(createdClinics.map((id) => deleteTestClinic(sql, id)));
  await sql.end();
});

describe('clinic_integrations.clinic_id immutability trigger (PR-D #7)', () => {
  it('UPDATE alterando clinic_id raises exception, mesmo via service_role', async () => {
    const a = await createTestClinic(sql, 'Immut-A');
    createdClinics.push(a.id);
    const b = await createTestClinic(sql, 'Immut-B');
    createdClinics.push(b.id);
    const intA = await createTestIntegration(sql, a.id);

    await expect(sql`
      UPDATE clinic_integrations SET clinic_id = ${b.id} WHERE id = ${intA.id}
    `).rejects.toThrow(/immutable|cannot change clinic_id/i);

    const [row] = await sql<{ clinic_id: string }[]>`
      SELECT clinic_id FROM clinic_integrations WHERE id = ${intA.id}
    `;
    expect(row?.clinic_id).toBe(a.id);
  });

  it('UPDATE mantendo clinic_id igual ao OLD passa (no-op same-value SET)', async () => {
    const a = await createTestClinic(sql, 'Immut-C');
    createdClinics.push(a.id);
    const intA = await createTestIntegration(sql, a.id);

    await sql`
      UPDATE clinic_integrations
      SET config = jsonb_set(config, '{phone_number_id}', '"123"'::jsonb),
          clinic_id = ${a.id}
      WHERE id = ${intA.id}
    `;
    const [row] = await sql<{ config: Record<string, unknown> }[]>`
      SELECT config FROM clinic_integrations WHERE id = ${intA.id}
    `;
    expect((row?.config as { phone_number_id?: string })?.phone_number_id).toBe('123');
  });

  it('UPDATE sem mexer em clinic_id passa (config-only update)', async () => {
    const a = await createTestClinic(sql, 'Immut-D');
    createdClinics.push(a.id);
    const intA = await createTestIntegration(sql, a.id);

    await sql`
      UPDATE clinic_integrations
      SET config = '{"phone_number_id":"456"}'::jsonb
      WHERE id = ${intA.id}
    `;
    const [row] = await sql<{ config: Record<string, unknown> }[]>`
      SELECT config FROM clinic_integrations WHERE id = ${intA.id}
    `;
    expect((row?.config as { phone_number_id?: string })?.phone_number_id).toBe('456');
  });
});

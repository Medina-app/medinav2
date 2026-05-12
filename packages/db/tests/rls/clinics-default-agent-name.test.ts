import { describe, it, expect, afterAll } from 'vitest';
import {
  getServiceClient,
  createTestClinic,
  deleteTestClinic,
} from './helpers/setup.js';

const sql = getServiceClient();
const createdClinics: string[] = [];

afterAll(async () => {
  await Promise.all(createdClinics.map((id) => deleteTestClinic(sql, id)));
  await sql.end();
});

describe('clinics.default_agent_name (PR-E GH #8)', () => {
  it('column exists and defaults to "agente-principal" on new clinic', async () => {
    const c = await createTestClinic(sql, 'DefaultAgentName-Default');
    createdClinics.push(c.id);

    const [row] = await sql<{ default_agent_name: string }[]>`
      SELECT default_agent_name FROM clinics WHERE id = ${c.id}
    `;
    expect(row?.default_agent_name).toBe('agente-principal');
  });

  it('column accepts non-default value', async () => {
    const c = await createTestClinic(sql, 'DefaultAgentName-Triagem');
    createdClinics.push(c.id);

    await sql`UPDATE clinics SET default_agent_name = 'agente-triagem' WHERE id = ${c.id}`;
    const [row] = await sql<{ default_agent_name: string }[]>`
      SELECT default_agent_name FROM clinics WHERE id = ${c.id}
    `;
    expect(row?.default_agent_name).toBe('agente-triagem');
  });

  it('column rejects NULL', async () => {
    const c = await createTestClinic(sql, 'DefaultAgentName-NotNull');
    createdClinics.push(c.id);

    await expect(sql`
      UPDATE clinics SET default_agent_name = NULL WHERE id = ${c.id}
    `).rejects.toThrow(/null|violates/i);
  });
});

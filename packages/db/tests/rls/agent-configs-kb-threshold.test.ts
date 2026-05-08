import { describe, it, expect, afterAll } from 'vitest';
import {
  getServiceClient,
  createTestClinic,
  createTestAgentConfig,
  deleteTestClinic,
} from './helpers/setup.js';

const sql = getServiceClient();
const createdClinicIds: string[] = [];

afterAll(async () => {
  await Promise.all(createdClinicIds.map((id) => deleteTestClinic(sql, id)));
  await sql.end();
});

async function makeClinic(name: string): Promise<{ id: string }> {
  const c = await createTestClinic(sql, name);
  createdClinicIds.push(c.id);
  return c;
}

describe('AI follow-up #21: agent_configs.kb_similarity_threshold', () => {
  it('1. coluna existe e default = 0.4 em rows novas', async () => {
    const c = await makeClinic('KbThreshold-Default');
    const cfg = await createTestAgentConfig(sql, c.id);

    const [row] = await sql<{ kb_similarity_threshold: string }[]>`
      SELECT kb_similarity_threshold FROM agent_configs WHERE id = ${cfg.id}
    `;
    expect(row).toBeDefined();
    // PostgREST/postgres-js retorna numeric como string; parse pra number.
    expect(parseFloat(row?.kb_similarity_threshold ?? '0')).toBeCloseTo(0.4, 2);
  });

  it('2. CHECK rejeita valor < 0', async () => {
    const c = await makeClinic('KbThreshold-Below');
    const cfg = await createTestAgentConfig(sql, c.id);

    await expect(sql`
      UPDATE agent_configs SET kb_similarity_threshold = -0.1 WHERE id = ${cfg.id}
    `).rejects.toThrow(/check constraint|kb_similarity_threshold_valid/i);
  });

  it('3. CHECK rejeita valor > 1', async () => {
    const c = await makeClinic('KbThreshold-Above');
    const cfg = await createTestAgentConfig(sql, c.id);

    await expect(sql`
      UPDATE agent_configs SET kb_similarity_threshold = 1.01 WHERE id = ${cfg.id}
    `).rejects.toThrow(/check constraint|kb_similarity_threshold_valid/i);
  });

  it('4. aceita boundaries 0.0, 0.5, 1.0', async () => {
    const c = await makeClinic('KbThreshold-Boundaries');
    const cfg = await createTestAgentConfig(sql, c.id);

    for (const value of [0.0, 0.5, 1.0]) {
      await sql`UPDATE agent_configs SET kb_similarity_threshold = ${value} WHERE id = ${cfg.id}`;
      const [row] = await sql<{ kb_similarity_threshold: string }[]>`
        SELECT kb_similarity_threshold FROM agent_configs WHERE id = ${cfg.id}
      `;
      expect(parseFloat(row?.kb_similarity_threshold ?? '?')).toBeCloseTo(value, 2);
    }
  });
});

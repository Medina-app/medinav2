import { describe, it, expect, afterAll } from 'vitest';
import {
  getServiceClient,
  createTestClinic,
  createTestIntegration,
  createTestConversation,
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
  await Promise.all(createdClinicIds.map((id) => deleteTestClinic(sql, id)));
  await Promise.all(createdUserIds.map((id) => deleteTestUser(sql, id)));
  await sql.end();
});

async function makeClinic(name: string): Promise<{ id: string }> {
  const c = await createTestClinic(sql, name);
  createdClinicIds.push(c.id);
  return c;
}

async function makeUser(): Promise<{ id: string; email: string }> {
  const u = await createTestUser(sql);
  createdUserIds.push(u.id);
  return u;
}

describe('AI follow-up #12: collect_info_atomic RPC', () => {
  it('1. atomic: insere field em conversations.metadata.collected_info', async () => {
    const c = await makeClinic('CollectAtomic-Insert');
    const intg = await createTestIntegration(sql, c.id);
    const conv = await createTestConversation(sql, c.id, intg.id);

    await sql`
      SELECT collect_info_atomic(
        ${conv.id}::uuid, ${c.id}::uuid, 'name', '2026-05-08T10:00:00Z'
      )
    `;

    // Verify persisted via SELECT direto na metadata.
    const [row] = await sql<{ metadata: { collected_info?: Record<string, string> } }[]>`
      SELECT metadata FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.metadata.collected_info?.['name']).toBe('2026-05-08T10:00:00Z');
  });

  it('2. preserva fields anteriores em chamadas subsequentes (atomic merge)', async () => {
    const c = await makeClinic('CollectAtomic-Merge');
    const intg = await createTestIntegration(sql, c.id);
    const conv = await createTestConversation(sql, c.id, intg.id);

    await sql`SELECT collect_info_atomic(${conv.id}::uuid, ${c.id}::uuid, 'name', '2026-05-08T10:00:00Z')`;
    await sql`SELECT collect_info_atomic(${conv.id}::uuid, ${c.id}::uuid, 'age', '2026-05-08T10:01:00Z')`;
    await sql`SELECT collect_info_atomic(${conv.id}::uuid, ${c.id}::uuid, 'reason', '2026-05-08T10:02:00Z')`;

    const [row] = await sql<{ metadata: { collected_info: Record<string, string> } }[]>`
      SELECT metadata FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.metadata.collected_info).toEqual({
      name: '2026-05-08T10:00:00Z',
      age: '2026-05-08T10:01:00Z',
      reason: '2026-05-08T10:02:00Z',
    });
  });

  it('3. cross-tenant violation: caller passa wrong clinic_id', async () => {
    const clinicA = await makeClinic('CollectAtomic-CrossA');
    const clinicB = await makeClinic('CollectAtomic-CrossB');
    const intgA = await createTestIntegration(sql, clinicA.id);
    const conv = await createTestConversation(sql, clinicA.id, intgA.id);

    await expect(sql`
      SELECT collect_info_atomic(${conv.id}::uuid, ${clinicB.id}::uuid, 'name', '2026-05-08T10:00:00Z')
    `).rejects.toThrow(/cross-tenant violation/);

    // Conversa intacta — metadata sem collected_info.
    const [row] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.metadata['collected_info']).toBeUndefined();
  });

  it('4. authenticated NÃO pode chamar (REVOKE — service_role only)', async () => {
    const c = await makeClinic('CollectAtomic-AuthDeny');
    const user = await makeUser();
    await addUserToClinic(sql, c.id, user.id, 'member');
    const intg = await createTestIntegration(sql, c.id);
    const conv = await createTestConversation(sql, c.id, intg.id);

    const rls = getRlsClient(sql, user.id);

    await expect(
      rls.query((tx) => tx`
        SELECT collect_info_atomic(${conv.id}::uuid, ${c.id}::uuid, 'name', '2026-05-08T10:00:00Z')
      `),
    ).rejects.toThrow(/permission denied|does not exist|insufficient privilege/i);
  });

  it('5. preserva metadata fields fora de collected_info (não overwrita ad-hoc)', async () => {
    const c = await makeClinic('CollectAtomic-Preserve');
    const intg = await createTestIntegration(sql, c.id);
    const conv = await createTestConversation(sql, c.id, intg.id);

    // Setar metadata manual com outros fields.
    await sql`
      UPDATE conversations
      SET metadata = '{"source":"whatsapp","version":2,"collected_info":{"phone_alt":"+5511999999999"}}'::jsonb
      WHERE id = ${conv.id}
    `;

    await sql`SELECT collect_info_atomic(${conv.id}::uuid, ${c.id}::uuid, 'name', '2026-05-08T10:00:00Z')`;

    const [row] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.metadata['source']).toBe('whatsapp');
    expect(row?.metadata['version']).toBe(2);
    const collected = row?.metadata['collected_info'] as Record<string, string>;
    expect(collected['phone_alt']).toBe('+5511999999999');
    expect(collected['name']).toBe('2026-05-08T10:00:00Z');
  });

  it('6. p_field vazio rejeitado', async () => {
    const c = await makeClinic('CollectAtomic-EmptyField');
    const intg = await createTestIntegration(sql, c.id);
    const conv = await createTestConversation(sql, c.id, intg.id);

    await expect(sql`
      SELECT collect_info_atomic(${conv.id}::uuid, ${c.id}::uuid, '', '2026-05-08T10:00:00Z')
    `).rejects.toThrow(/non-empty/);
  });
});

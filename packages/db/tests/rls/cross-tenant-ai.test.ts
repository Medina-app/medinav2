import { describe, it, expect, afterAll } from 'vitest';
import {
  getServiceClient,
  createTestClinic,
  createTestIntegration,
  createTestConversation,
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

describe('escalate_conversation (atomic, PR-A #11+#13)', () => {
  it('altera state, escalated_via, insere system message E audit_logs atomicamente', async () => {
    const clinic = await makeClinic('Esc-Atomic');
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    const [row] = await sql<{ ok: boolean }[]>`
      SELECT escalate_conversation(
        ${conv.id}::uuid, ${clinic.id}::uuid, 'paciente em urgência'
      ) AS ok
    `;
    expect(row?.ok).toBe(true);

    const [convAfter] = await sql<{ state: string; escalated_via: string }[]>`
      SELECT state, escalated_via FROM conversations WHERE id = ${conv.id}
    `;
    expect(convAfter?.state).toBe('waiting_human');
    expect(convAfter?.escalated_via).toBe('ai');

    const msgs = await sql<{ content: string; sender_type: string }[]>`
      SELECT content, sender_type FROM messages WHERE conversation_id = ${conv.id}
    `;
    const sysMsg = msgs.find((m) => m.sender_type === 'system');
    expect(sysMsg?.content).toMatch(/IA escalou/);

    type AuditRow = { action: string; metadata: Record<string, unknown> };
    const audits = await sql<AuditRow[]>`
      SELECT action, metadata FROM audit_logs
      WHERE resource_id = ${conv.id}
      ORDER BY created_at ASC
    `;
    const stateChanged = audits.find((a) => a.action === 'conversation.state_changed');
    const toolAudit = audits.find((a) => a.action === 'agent.tool.escalate');
    expect(stateChanged).toBeDefined();
    expect(toolAudit).toBeDefined();
    expect((toolAudit?.metadata as { tool?: string })?.tool).toBe('escalate_to_human');
    expect((toolAudit?.metadata as { source?: string })?.source).toBe('ai');
  });

  it('cross-tenant violation lança exception (caller passa wrong clinic_id)', async () => {
    const clinicA = await makeClinic('Esc-A');
    const clinicB = await makeClinic('Esc-B');
    const intA = await createTestIntegration(sql, clinicA.id);
    const conv = await createTestConversation(sql, clinicA.id, intA.id);

    await expect(sql`
      SELECT escalate_conversation(${conv.id}::uuid, ${clinicB.id}::uuid, 'malicious')
    `).rejects.toThrow(/cross-tenant violation/);

    const [row] = await sql<{ state: string; escalated_via: string | null }[]>`
      SELECT state, escalated_via FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.state).toBe('ai_handling');
    expect(row?.escalated_via).toBeNull();
  });

  it('idempotência: chamar duas vezes — segunda retorna false, sem duplicar message', async () => {
    const clinic = await makeClinic('Esc-Idem');
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    const [first] = await sql<{ ok: boolean }[]>`
      SELECT escalate_conversation(${conv.id}::uuid, ${clinic.id}::uuid, 'first call') AS ok
    `;
    const [second] = await sql<{ ok: boolean }[]>`
      SELECT escalate_conversation(${conv.id}::uuid, ${clinic.id}::uuid, 'second call') AS ok
    `;
    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(false);

    const countRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM messages
      WHERE conversation_id = ${conv.id} AND sender_type = 'system'
    `;
    expect(Number(countRows[0]?.count ?? '0')).toBe(1);
  });
});

describe('transition_conversation_state escalated_via flag (PR-A #13)', () => {
  it('4-arg overload com escalated_via_value=manual seta flag', async () => {
    const clinic = await makeClinic('TC-Manual');
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    await sql`
      SELECT transition_conversation_state(
        ${conv.id}::uuid, 'waiting_human', 'human_paused_ai', 'manual'
      )
    `;
    const [row] = await sql<{ state: string; escalated_via: string }[]>`
      SELECT state, escalated_via FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.state).toBe('waiting_human');
    expect(row?.escalated_via).toBe('manual');
  });

  it('voltar pra ai_handling via 3-arg limpa escalated_via=NULL', async () => {
    const clinic = await makeClinic('TC-Resume');
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    await sql`SELECT escalate_conversation(${conv.id}::uuid, ${clinic.id}::uuid, 'first')`;
    // Religar IA via 3-arg overload (testes de chat.test.ts seguem usando 3-arg).
    await sql`SELECT transition_conversation_state(${conv.id}::uuid, 'ai_handling', 'human_returned_to_ai')`;
    const [row] = await sql<{ state: string; escalated_via: string | null }[]>`
      SELECT state, escalated_via FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.state).toBe('ai_handling');
    expect(row?.escalated_via).toBeNull();
  });
});

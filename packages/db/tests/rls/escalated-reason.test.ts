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

describe('AI-5: conversations.escalated_reason + escalate_conversation_with_reason', () => {
  it('1. coluna escalated_reason existe e default NULL', async () => {
    const c = await makeClinic('Reason-Col');
    const intg = await createTestIntegration(sql, c.id);
    const conv = await createTestConversation(sql, c.id, intg.id);

    const [row] = await sql<{ escalated_reason: string | null }[]>`
      SELECT escalated_reason FROM conversations WHERE id = ${conv.id}
    `;
    expect(row).toBeDefined();
    expect(row?.escalated_reason).toBeNull();
  });

  it('2. CHECK rejeita escalated_reason fora do enum válido', async () => {
    const c = await makeClinic('Reason-Check');
    const intg = await createTestIntegration(sql, c.id);
    const conv = await createTestConversation(sql, c.id, intg.id);

    await expect(sql`
      UPDATE conversations SET escalated_reason = 'invalid_category' WHERE id = ${conv.id}
    `).rejects.toThrow(/escalated_reason|check constraint|conversations_escalated_reason_valid/i);

    // Sanity: valid value passes.
    await sql`UPDATE conversations SET escalated_reason = 'medication' WHERE id = ${conv.id}`;
    const [row] = await sql<{ escalated_reason: string }[]>`
      SELECT escalated_reason FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.escalated_reason).toBe('medication');
  });

  it('3. 5-arg transition_conversation_state aceita escalated_reason_value', async () => {
    const c = await makeClinic('Reason-5arg');
    const intg = await createTestIntegration(sql, c.id);
    const conv = await createTestConversation(sql, c.id, intg.id);

    await sql`
      SELECT transition_conversation_state(
        ${conv.id}::uuid,
        'waiting_human',
        'guardrail trigger',
        'ai',
        'diagnosis'
      )
    `;
    const [row] = await sql<{ state: string; escalated_via: string; escalated_reason: string }[]>`
      SELECT state, escalated_via, escalated_reason FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.state).toBe('waiting_human');
    expect(row?.escalated_via).toBe('ai');
    expect(row?.escalated_reason).toBe('diagnosis');
  });

  it('4. escalate_conversation_with_reason: atomic (state + flag + reason + system msg + audits)', async () => {
    const c = await makeClinic('Reason-Atomic');
    const intg = await createTestIntegration(sql, c.id);
    const conv = await createTestConversation(sql, c.id, intg.id);

    const [r] = await sql<{ ok: boolean }[]>`
      SELECT escalate_conversation_with_reason(
        ${conv.id}::uuid, ${c.id}::uuid, 'paciente pediu remedio', 'medication'
      ) AS ok
    `;
    expect(r?.ok).toBe(true);

    const [convAfter] = await sql<
      { state: string; escalated_via: string; escalated_reason: string }[]
    >`
      SELECT state, escalated_via, escalated_reason FROM conversations WHERE id = ${conv.id}
    `;
    expect(convAfter?.state).toBe('waiting_human');
    expect(convAfter?.escalated_via).toBe('ai');
    expect(convAfter?.escalated_reason).toBe('medication');

    const msgs = await sql<{ content: string; sender_type: string }[]>`
      SELECT content, sender_type FROM messages WHERE conversation_id = ${conv.id}
    `;
    const sysMsg = msgs.find((m) => m.sender_type === 'system');
    expect(sysMsg).toBeDefined();
  });

  it('5. cross-tenant violation: caller passa wrong clinic_id → exception, conversation intacta', async () => {
    const clinicA = await makeClinic('Reason-CrossA');
    const clinicB = await makeClinic('Reason-CrossB');
    const intgA = await createTestIntegration(sql, clinicA.id);
    const conv = await createTestConversation(sql, clinicA.id, intgA.id);

    await expect(sql`
      SELECT escalate_conversation_with_reason(
        ${conv.id}::uuid, ${clinicB.id}::uuid, 'malicious', 'medication'
      )
    `).rejects.toThrow(/cross-tenant violation/);

    const [row] = await sql<
      { state: string; escalated_via: string | null; escalated_reason: string | null }[]
    >`
      SELECT state, escalated_via, escalated_reason FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.state).toBe('ai_handling');
    expect(row?.escalated_via).toBeNull();
    expect(row?.escalated_reason).toBeNull();
  });

  it('6. idempotência: segunda chamada retorna false, sem duplicar system message', async () => {
    const c = await makeClinic('Reason-Idem');
    const intg = await createTestIntegration(sql, c.id);
    const conv = await createTestConversation(sql, c.id, intg.id);

    const [first] = await sql<{ ok: boolean }[]>`
      SELECT escalate_conversation_with_reason(
        ${conv.id}::uuid, ${c.id}::uuid, 'first call', 'urgency'
      ) AS ok
    `;
    const [second] = await sql<{ ok: boolean }[]>`
      SELECT escalate_conversation_with_reason(
        ${conv.id}::uuid, ${c.id}::uuid, 'second call', 'urgency'
      ) AS ok
    `;
    expect(first?.ok).toBe(true);
    expect(second?.ok).toBe(false);

    const msgs = await sql<{ id: string }[]>`
      SELECT id FROM messages WHERE conversation_id = ${conv.id} AND sender_type = 'system'
    `;
    expect(msgs.length).toBe(1);
  });

  it('7. system message tem prefix 🛡️ + categoria entre parênteses', async () => {
    const c = await makeClinic('Reason-Prefix');
    const intg = await createTestIntegration(sql, c.id);
    const conv = await createTestConversation(sql, c.id, intg.id);

    await sql`
      SELECT escalate_conversation_with_reason(
        ${conv.id}::uuid, ${c.id}::uuid, 'paciente em ideacao suicida', 'urgency'
      )
    `;
    const [msg] = await sql<{ content: string }[]>`
      SELECT content FROM messages
      WHERE conversation_id = ${conv.id} AND sender_type = 'system'
    `;
    expect(msg?.content).toMatch(/^🛡️ IA escalou \(urgency\)/);
    expect(msg?.content).toContain('paciente em ideacao suicida');
  });

  it('8. audit_logs registra action=agent.guardrail.escalate com category', async () => {
    const c = await makeClinic('Reason-Audit');
    const intg = await createTestIntegration(sql, c.id);
    const conv = await createTestConversation(sql, c.id, intg.id);

    await sql`
      SELECT escalate_conversation_with_reason(
        ${conv.id}::uuid, ${c.id}::uuid, 'pediu diagnostico', 'diagnosis'
      )
    `;
    type AuditRow = { action: string; metadata: Record<string, unknown> };
    const audits = await sql<AuditRow[]>`
      SELECT action, metadata FROM audit_logs
      WHERE resource_id = ${conv.id}
      ORDER BY created_at ASC
    `;
    const guardrailAudit = audits.find((a) => a.action === 'agent.guardrail.escalate');
    expect(guardrailAudit).toBeDefined();
    expect((guardrailAudit?.metadata as { category?: string })?.category).toBe('diagnosis');
    expect((guardrailAudit?.metadata as { source?: string })?.source).toBe('ai');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic,
  cleanupAll,
  createTestClinic,
  createTestConversation,
  createTestIntegration,
  createTestMessage,
  createTestPatient,
  createTestUser,
  getRlsClient,
  getServiceClient,
} from './helpers/setup.js';

const sql = getServiceClient();
beforeAll(async () => { await cleanupAll(sql); });
afterAll(async () => { await cleanupAll(sql); await sql.end(); });

describe('conversations: cross-tenant isolation', () => {
  it('users only see conversations of their clinics', async () => {
    const cA = await createTestClinic(sql, 'Conv A');
    const cB = await createTestClinic(sql, 'Conv B');
    const uA = await createTestUser(sql);
    const uB = await createTestUser(sql);
    await addUserToClinic(sql, cA.id, uA.id);
    await addUserToClinic(sql, cB.id, uB.id);
    const intA = await createTestIntegration(sql, cA.id);
    const intB = await createTestIntegration(sql, cB.id);
    const convA = await createTestConversation(sql, cA.id, intA.id);
    await createTestConversation(sql, cB.id, intB.id);

    const rows = await getRlsClient(sql, uA.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM conversations`,
    );
    expect(rows.map((r) => r.id)).toEqual([convA.id]);
  });
});

describe('messages: cross-tenant isolation', () => {
  it('users only see messages of their clinics', async () => {
    const cA = await createTestClinic(sql, 'Msg A');
    const cB = await createTestClinic(sql, 'Msg B');
    const uA = await createTestUser(sql);
    await addUserToClinic(sql, cA.id, uA.id);
    const intA = await createTestIntegration(sql, cA.id);
    const intB = await createTestIntegration(sql, cB.id);
    const convA = await createTestConversation(sql, cA.id, intA.id);
    const convB = await createTestConversation(sql, cB.id, intB.id);
    const msgA = await createTestMessage(sql, convA.id, cA.id);
    await createTestMessage(sql, convB.id, cB.id);

    const rows = await getRlsClient(sql, uA.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM messages`,
    );
    expect(rows.map((r) => r.id)).toEqual([msgA.id]);
  });
});

describe('conversations: insert policies', () => {
  it('non-member cannot insert conversation', async () => {
    const clinic = await createTestClinic(sql, 'Non-member C');
    const outsider = await createTestUser(sql);
    const integration = await createTestIntegration(sql, clinic.id);

    await expect(
      getRlsClient(sql, outsider.id).query((tx) =>
        tx`INSERT INTO conversations (clinic_id, integration_id, channel, external_id)
           VALUES (${clinic.id}, ${integration.id}, 'whatsapp', '+5511000000001')`,
      ),
    ).rejects.toThrow();
  });

  it('members can insert conversation and message', async () => {
    const clinic = await createTestClinic(sql, 'Member Insert');
    const user = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, user.id);
    const integration = await createTestIntegration(sql, clinic.id);

    const convRows = await getRlsClient(sql, user.id).query((tx) =>
      tx<{ id: string }[]>`
        INSERT INTO conversations (clinic_id, integration_id, channel, external_id)
        VALUES (${clinic.id}, ${integration.id}, 'whatsapp', '+5511000000002')
        RETURNING id
      `,
    );
    expect(convRows[0]?.id).toBeDefined();

    const convId = convRows[0]!.id;
    const msgRows = await getRlsClient(sql, user.id).query((tx) =>
      tx<{ id: string }[]>`
        INSERT INTO messages (conversation_id, clinic_id, direction, sender_type, content_type, content)
        VALUES (${convId}, ${clinic.id}, 'inbound', 'patient', 'text', 'Hello')
        RETURNING id
      `,
    );
    expect(msgRows[0]?.id).toBeDefined();
  });
});

describe('state machine', () => {
  it('only allowed state transitions succeed', async () => {
    const clinic = await createTestClinic(sql, 'State Machine');
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    // Valid: ai_handling → waiting_human
    await sql`SELECT transition_conversation_state(${conv.id}, 'waiting_human', 'handoff')`;
    const [updated] = await sql<{ state: string }[]>`
      SELECT state FROM conversations WHERE id = ${conv.id}
    `;
    expect(updated?.state).toBe('waiting_human');

    // Invalid: waiting_human → awaiting_template_response (not allowed)
    await expect(
      sql`SELECT transition_conversation_state(${conv.id}, 'awaiting_template_response')`,
    ).rejects.toThrow('Invalid state transition');
  });
});

describe('soft delete', () => {
  it('messages remain accessible when conversation is soft-deleted', async () => {
    const clinic = await createTestClinic(sql, 'Soft Delete');
    const user = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, user.id);
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);
    const msg = await createTestMessage(sql, conv.id, clinic.id);

    // Soft-delete the conversation via service_role
    await sql`UPDATE conversations SET deleted_at = NOW() WHERE id = ${conv.id}`;

    // Member cannot see soft-deleted conversation
    const convRows = await getRlsClient(sql, user.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM conversations WHERE id = ${conv.id}`,
    );
    expect(convRows).toHaveLength(0);

    // Messages remain accessible (message RLS uses clinic_id only)
    const msgRows = await getRlsClient(sql, user.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM messages WHERE id = ${msg.id}`,
    );
    expect(msgRows.map((r) => r.id)).toEqual([msg.id]);
  });
});

describe('audit log', () => {
  it('state changes are audit-logged automatically via transition_conversation_state', async () => {
    const clinic = await createTestClinic(sql, 'Audit State');
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    await sql`SELECT transition_conversation_state(${conv.id}, 'waiting_human', 'manual-handoff')`;

    type AuditRow = { resource: string; metadata: { before: Record<string, unknown>; after: Record<string, unknown> } };
    const logs = await sql<AuditRow[]>`
      SELECT resource, metadata
      FROM audit_logs
      WHERE resource_id = ${conv.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(logs[0]?.resource).toBe('conversations');
    expect(logs[0]?.metadata?.after?.['state']).toBe('waiting_human');
    expect(logs[0]?.metadata?.before?.['state']).toBe('ai_handling');
  });
});

describe('cross-tenant FK guard', () => {
  it('cannot link conversation to patient from another clinic', async () => {
    const cA = await createTestClinic(sql, 'Cross A');
    const cB = await createTestClinic(sql, 'Cross B');
    const intA = await createTestIntegration(sql, cA.id);
    const patientB = await createTestPatient(sql, cB.id);

    await expect(
      sql`INSERT INTO conversations (clinic_id, integration_id, channel, external_id, patient_id)
          VALUES (${cA.id}, ${intA.id}, 'whatsapp', '+5511000000003', ${patientB.id})`,
    ).rejects.toThrow();
  });
});

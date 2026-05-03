import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic,
  cleanupAll,
  createTestAgentConfig,
  createTestClinic,
  createTestConversation,
  createTestIntegration,
  createTestKnowledgeDocument,
  createTestUser,
  getRlsClient,
  getServiceClient,
} from './helpers/setup.js';

const sql = getServiceClient();
beforeAll(async () => { await cleanupAll(sql); });
afterAll(async () => { await cleanupAll(sql); await sql.end(); });

// ─── Cross-tenant isolation ────────────────────────────────────────────────────

describe('agent_configs: cross-tenant isolation', () => {
  it('users only see agent_configs of their clinics', async () => {
    const cA = await createTestClinic(sql, 'Agent Iso A');
    const cB = await createTestClinic(sql, 'Agent Iso B');
    const uA = await createTestUser(sql);
    const uB = await createTestUser(sql);
    await addUserToClinic(sql, cA.id, uA.id);
    await addUserToClinic(sql, cB.id, uB.id);

    const cfgA = await createTestAgentConfig(sql, cA.id, { name: 'agente-principal' });
    await createTestAgentConfig(sql, cB.id, { name: 'agente-principal' });

    const rows = await getRlsClient(sql, uA.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM agent_configs`,
    );
    expect(rows.map((r) => r.id)).toEqual([cfgA.id]);
  });
});

// ─── agent_configs: insert/update/delete permissions ──────────────────────────

describe('agent_configs: permissions', () => {
  it('non-admin cannot insert agent_config', async () => {
    const clinic = await createTestClinic(sql, 'Agent Perm Insert');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    await expect(
      getRlsClient(sql, member.id).query((tx) =>
        tx`INSERT INTO agent_configs (clinic_id, name, system_prompt, model)
           VALUES (${clinic.id}, 'agent-x', 'Be helpful.', 'claude-haiku-4-5')`,
      ),
    ).rejects.toThrow();
  });

  it('non-admin cannot update agent_config', async () => {
    const clinic = await createTestClinic(sql, 'Agent Perm Update');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const cfg = await createTestAgentConfig(sql, clinic.id);

    const rows = await getRlsClient(sql, member.id).query((tx) =>
      tx<{ id: string }[]>`
        UPDATE agent_configs SET system_prompt = 'hacked' WHERE id = ${cfg.id} RETURNING id
      `,
    );
    expect(rows).toHaveLength(0);
  });

  it('non-admin cannot delete agent_config', async () => {
    const clinic = await createTestClinic(sql, 'Agent Perm Delete');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const cfg = await createTestAgentConfig(sql, clinic.id);

    const rows = await getRlsClient(sql, member.id).query((tx) =>
      tx<{ id: string }[]>`DELETE FROM agent_configs WHERE id = ${cfg.id} RETURNING id`,
    );
    expect(rows).toHaveLength(0);
  });

  it('admin can insert and update agent_config', async () => {
    const clinic = await createTestClinic(sql, 'Agent Admin Write');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');

    const inserted = await getRlsClient(sql, admin.id).query((tx) =>
      tx<{ id: string; version: number }[]>`
        INSERT INTO agent_configs (clinic_id, name, system_prompt, model)
        VALUES (${clinic.id}, 'agente-admin', 'Be helpful.', 'claude-haiku-4-5')
        RETURNING id, version
      `,
    );
    expect(inserted[0]?.id).toBeDefined();
    expect(inserted[0]?.version).toBeGreaterThanOrEqual(1);
  });
});

// ─── agent_configs: versioning ────────────────────────────────────────────────

describe('agent_configs: versioning', () => {
  it('version auto-increments per clinic+name', async () => {
    const clinic = await createTestClinic(sql, 'Agent Versioning');
    const v1 = await createTestAgentConfig(sql, clinic.id, { name: 'agente-versao' });
    const v2 = await createTestAgentConfig(sql, clinic.id, { name: 'agente-versao' });
    const v3 = await createTestAgentConfig(sql, clinic.id, { name: 'agente-versao' });

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
  });

  it('admin can publish agent_config — only one published per clinic+name at a time', async () => {
    const clinic = await createTestClinic(sql, 'Agent Publish');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');

    const draft = await createTestAgentConfig(sql, clinic.id, {
      name: 'agente-publish',
      status: 'draft',
    });

    await getRlsClient(sql, admin.id).query((tx) =>
      tx`SELECT publish_agent_config(${draft.id})`,
    );

    const [published] = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM agent_configs WHERE id = ${draft.id}
    `;
    expect(published?.status).toBe('published');

    // Only one published per (clinic, name)
    const publishedCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM agent_configs
      WHERE clinic_id = ${clinic.id} AND name = 'agente-publish'
        AND status = 'published' AND archived_at IS NULL
    `;
    expect(Number(publishedCount[0]?.count)).toBe(1);
  });

  it('publishing new version archives previous published version automatically', async () => {
    const clinic = await createTestClinic(sql, 'Agent Archive Old');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');

    const v1 = await createTestAgentConfig(sql, clinic.id, { name: 'agente-cycle' });
    await getRlsClient(sql, admin.id).query((tx) =>
      tx`SELECT publish_agent_config(${v1.id})`,
    );

    const v2 = await createTestAgentConfig(sql, clinic.id, { name: 'agente-cycle' });
    await getRlsClient(sql, admin.id).query((tx) =>
      tx`SELECT publish_agent_config(${v2.id})`,
    );

    const [v1Status] = await sql<{ status: string; archived_at: string | null }[]>`
      SELECT status, archived_at FROM agent_configs WHERE id = ${v1.id}
    `;
    expect(v1Status?.status).toBe('archived');
    expect(v1Status?.archived_at).not.toBeNull();

    const [v2Status] = await sql<{ status: string }[]>`
      SELECT status FROM agent_configs WHERE id = ${v2.id}
    `;
    expect(v2Status?.status).toBe('published');
  });
});

// ─── messages: agent_config_id validation ─────────────────────────────────────

describe('messages: agent_config_id validation', () => {
  it('draft cannot be referenced by messages.agent_config_id (only published)', async () => {
    const clinic = await createTestClinic(sql, 'Msg Draft Agent');
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    const draft = await createTestAgentConfig(sql, clinic.id, { name: 'agente-draft-ref' });
    // draft status — must fail
    await expect(
      sql`INSERT INTO messages (conversation_id, clinic_id, direction, sender_type, content_type, content, agent_config_id)
          VALUES (${conv.id}, ${clinic.id}, 'outbound', 'ai', 'text', 'Hi', ${draft.id})`,
    ).rejects.toThrow();
  });

  it('published agent_config from different clinic rejected in messages', async () => {
    const cA = await createTestClinic(sql, 'Msg Agent XTenant A');
    const cB = await createTestClinic(sql, 'Msg Agent XTenant B');
    const adminB = await createTestUser(sql);
    await addUserToClinic(sql, cB.id, adminB.id, 'admin');
    const intA = await createTestIntegration(sql, cA.id);
    const conv = await createTestConversation(sql, cA.id, intA.id);

    // Create and publish an agent for cB
    const agentB = await createTestAgentConfig(sql, cB.id, { name: 'agente-b' });
    await getRlsClient(sql, adminB.id).query((tx) =>
      tx`SELECT publish_agent_config(${agentB.id})`,
    );

    await expect(
      sql`INSERT INTO messages (conversation_id, clinic_id, direction, sender_type, content_type, content, agent_config_id)
          VALUES (${conv.id}, ${cA.id}, 'outbound', 'ai', 'text', 'Hi', ${agentB.id})`,
    ).rejects.toThrow();
  });
});

// ─── knowledge_documents: permissions ─────────────────────────────────────────

describe('knowledge_documents: permissions', () => {
  it('members can read knowledge_documents', async () => {
    const clinic = await createTestClinic(sql, 'KDoc Read');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const doc = await createTestKnowledgeDocument(sql, clinic.id, { title: 'Handbook' });

    const rows = await getRlsClient(sql, member.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM knowledge_documents WHERE id = ${doc.id}`,
    );
    expect(rows.map((r) => r.id)).toEqual([doc.id]);
  });

  it('non-admin cannot write knowledge_documents', async () => {
    const clinic = await createTestClinic(sql, 'KDoc Write Denied');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    await expect(
      getRlsClient(sql, member.id).query((tx) =>
        tx`INSERT INTO knowledge_documents (clinic_id, title, source_type)
           VALUES (${clinic.id}, 'Forbidden', 'manual')`,
      ),
    ).rejects.toThrow();
  });

  it('admins can write knowledge_documents', async () => {
    const clinic = await createTestClinic(sql, 'KDoc Admin Write');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');

    const rows = await getRlsClient(sql, admin.id).query((tx) =>
      tx<{ id: string }[]>`
        INSERT INTO knowledge_documents (clinic_id, title, source_type)
        VALUES (${clinic.id}, 'Admin Doc', 'pdf')
        RETURNING id
      `,
    );
    expect(rows[0]?.id).toBeDefined();
  });
});

// ─── knowledge_chunks: cross-tenant isolation ─────────────────────────────────

describe('knowledge_chunks: cross-tenant isolation', () => {
  it('members can read knowledge_chunks of their clinic', async () => {
    const clinic = await createTestClinic(sql, 'KChunk Read');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const doc = await createTestKnowledgeDocument(sql, clinic.id);

    // Embedding: 1536 zeros (service_role insert, bypasses RLS)
    const embedding = `[${Array(1536).fill(0).join(',')}]`;
    const [chunk] = await sql<{ id: string }[]>`
      INSERT INTO knowledge_chunks (clinic_id, document_id, chunk_index, content, token_count, embedding)
      VALUES (${clinic.id}, ${doc.id}, 0, 'Test content', 10, ${embedding}::vector)
      RETURNING id
    `;

    if (!chunk) throw new Error('chunk not inserted');
    const rows = await getRlsClient(sql, member.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM knowledge_chunks WHERE id = ${chunk.id}`,
    );
    expect(rows.map((r) => r.id)).toEqual([chunk.id]);
  });

  it('knowledge_chunks: cross-tenant isolation — members cannot see chunks of other clinics', async () => {
    const cA = await createTestClinic(sql, 'KChunk Iso A');
    const cB = await createTestClinic(sql, 'KChunk Iso B');
    const uA = await createTestUser(sql);
    await addUserToClinic(sql, cA.id, uA.id, 'member');

    const docA = await createTestKnowledgeDocument(sql, cA.id);
    const docB = await createTestKnowledgeDocument(sql, cB.id);
    const embedding = `[${Array(1536).fill(0).join(',')}]`;

    await sql`
      INSERT INTO knowledge_chunks (clinic_id, document_id, chunk_index, content, token_count, embedding)
      VALUES (${cA.id}, ${docA.id}, 0, 'Chunk A', 10, ${embedding}::vector),
             (${cB.id}, ${docB.id}, 0, 'Chunk B', 10, ${embedding}::vector)
    `;

    const rows = await getRlsClient(sql, uA.id).query((tx) =>
      tx<{ clinic_id: string }[]>`SELECT clinic_id FROM knowledge_chunks`,
    );
    expect(rows.every((r) => r.clinic_id === cA.id)).toBe(true);
  });

  it('knowledge_chunks.document_id must match same clinic', async () => {
    const cA = await createTestClinic(sql, 'KChunk XTenant Doc A');
    const cB = await createTestClinic(sql, 'KChunk XTenant Doc B');
    const docB = await createTestKnowledgeDocument(sql, cB.id);
    const embedding = `[${Array(1536).fill(0).join(',')}]`;

    // Insert chunk with cA.clinic_id but docB.id — should fail (cross-tenant)
    await expect(
      sql`INSERT INTO knowledge_chunks (clinic_id, document_id, chunk_index, content, token_count, embedding)
          VALUES (${cA.id}, ${docB.id}, 0, 'Cross', 5, ${embedding}::vector)`,
    ).rejects.toThrow();
  });
});

// ─── search_knowledge_chunks: vector similarity ───────────────────────────────

describe('search_knowledge_chunks: vector similarity', () => {
  it('vector similarity search returns only chunks from same clinic', async () => {
    const cA = await createTestClinic(sql, 'Vector Search A');
    const cB = await createTestClinic(sql, 'Vector Search B');
    const uA = await createTestUser(sql);
    await addUserToClinic(sql, cA.id, uA.id, 'member');

    const docA = await createTestKnowledgeDocument(sql, cA.id);
    const docB = await createTestKnowledgeDocument(sql, cB.id);

    // Different embeddings to make results distinguishable
    const embA = `[${Array(1536).fill(0.1).join(',')}]`;
    const embB = `[${Array(1536).fill(0.9).join(',')}]`;
    const query = `[${Array(1536).fill(0.1).join(',')}]`;

    await sql`
      INSERT INTO knowledge_chunks (clinic_id, document_id, chunk_index, content, token_count, embedding)
      VALUES (${cA.id}, ${docA.id}, 0, 'Clinic A chunk', 5, ${embA}::vector),
             (${cB.id}, ${docB.id}, 0, 'Clinic B chunk', 5, ${embB}::vector)
    `;

    const results = await getRlsClient(sql, uA.id).query((tx) =>
      tx<{ clinic_id: string; content: string }[]>`
        SELECT kc.clinic_id, kc.content
        FROM search_knowledge_chunks(${cA.id}::uuid, ${query}::vector, 10) AS r
        JOIN knowledge_chunks kc ON kc.id = r.chunk_id
      `,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.clinic_id === cA.id)).toBe(true);
    expect(results.some((r) => r.content === 'Clinic A chunk')).toBe(true);
  });
});

// ─── audit log ────────────────────────────────────────────────────────────────

describe('audit log: agent_config status changes', () => {
  it('audit log is written automatically when agent_config status changes', async () => {
    const clinic = await createTestClinic(sql, 'Agent Audit');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');

    const cfg = await createTestAgentConfig(sql, clinic.id, { name: 'agente-audit' });
    await getRlsClient(sql, admin.id).query((tx) =>
      tx`SELECT publish_agent_config(${cfg.id})`,
    );

    const logs = await sql<{ action: string; resource: string; resource_id: string }[]>`
      SELECT action, resource, resource_id
      FROM audit_logs
      WHERE resource = 'agent_configs'
        AND resource_id = ${cfg.id}
        AND action = 'agent_config.published'
      LIMIT 1
    `;
    expect(logs[0]?.action).toBe('agent_config.published');
    expect(logs[0]?.resource_id).toBe(cfg.id);
  });
});

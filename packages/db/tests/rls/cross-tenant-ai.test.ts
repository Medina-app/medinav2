import { describe, it, expect, afterAll } from 'vitest';
import {
  getServiceClient,
  createTestClinic,
  createTestIntegration,
  createTestConversation,
  createTestKnowledgeDocument,
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

// ─── Cross-tenant defense in depth (PR-A #15) ───────────────────────────────
//
// Testa as barreiras DB-level que protegem contra cross-tenant leak. Cada
// barreira é necessária mas não suficiente isoladamente — defesa em profundidade
// significa que mesmo se uma falhar, as outras seguram.
//
// Layers cobertos aqui:
//   1. agent_configs SELECT pattern: dispatcher.ts:77-86 filtra por clinic_id
//      explicitamente. Mesmo com mesmo `name='agente-principal'` em duas
//      clinics, o filtro previne mistura.
//   2. search_knowledge_chunks_internal: RPC SECURITY DEFINER filtra
//      `WHERE kc.clinic_id = target_clinic_id`. Não confia em RLS (service_role
//      bypassa) — guard explícito no SQL.
//   3. escalate_conversation: já testado acima ("cross-tenant violation").
//      Esse describe adiciona variante explícita com 2 clinics ambas com
//      conversations ativas (em vez de só 1 conv existir).
//   4. transition_conversation_state: doc test executável — a função NÃO
//      valida tenant interno. É decisão consciente: o caller (toggleAiHandling
//      action ou Inngest worker) faz cross-tenant guard antes da RPC. Mover
//      essa validação pra dentro da função quebraria webhooks que precisam
//      passar clinic_id arbitrário (worker-side authorization).
describe('cross-tenant defense in depth (PR-A #15)', () => {
  it('agent_configs lookup: clinic-a query NEVER returns clinic-b config (mesmo com name=agente-principal colidindo)', async () => {
    const clinicA = await makeClinic('Xtenant-Agent-A');
    const clinicB = await makeClinic('Xtenant-Agent-B');

    // Cria agent_config published com mesmo name em AMBAS clinics — pattern
    // realista pois 'agente-principal' é o name padrão em todas as clinics.
    await sql`
      INSERT INTO agent_configs (clinic_id, name, status, system_prompt, model)
      VALUES
        (${clinicA.id}, 'agente-principal', 'published', 'I am A', 'claude-haiku-4-5'),
        (${clinicB.id}, 'agente-principal', 'published', 'I am B', 'claude-haiku-4-5')
    `;

    // Replicate exactly the dispatcher.ts:77-86 lookup pattern.
    const cfgsForA = await sql<{ system_prompt: string; clinic_id: string }[]>`
      SELECT system_prompt, clinic_id
      FROM agent_configs
      WHERE clinic_id = ${clinicA.id}
        AND status = 'published'
        AND name = 'agente-principal'
    `;
    expect(cfgsForA.length).toBe(1);
    expect(cfgsForA[0]?.clinic_id).toBe(clinicA.id);
    expect(cfgsForA[0]?.system_prompt).toBe('I am A');

    // Sanity: clinic-b's row exists but is invisible to A's query.
    const cfgsForB = await sql<{ system_prompt: string }[]>`
      SELECT system_prompt FROM agent_configs WHERE clinic_id = ${clinicB.id}
    `;
    expect(cfgsForB[0]?.system_prompt).toBe('I am B');
  });

  it('search_knowledge_chunks_internal: returns ONLY chunks of target_clinic_id, never cross-tenant leak', async () => {
    const clinicA = await makeClinic('Xtenant-KB-A');
    const clinicB = await makeClinic('Xtenant-KB-B');

    const docA = await createTestKnowledgeDocument(sql, clinicA.id, { title: 'Doc A' });
    const docB = await createTestKnowledgeDocument(sql, clinicB.id, { title: 'Doc B' });

    // Mesmo embedding fake (1536 dims) nas chunks de ambas — força a query a
    // depender só do filtro WHERE kc.clinic_id pra discriminar.
    const fakeEmbedding = `[${Array(1536).fill(0.1).join(',')}]`;
    await sql`
      INSERT INTO knowledge_chunks (clinic_id, document_id, content, embedding, chunk_index, token_count)
      VALUES
        (${clinicA.id}, ${docA.id}, 'segredo da clínica A', ${fakeEmbedding}::vector, 0, 5),
        (${clinicB.id}, ${docB.id}, 'segredo da clínica B', ${fakeEmbedding}::vector, 0, 5)
    `;

    // RPC chamada com target_clinic_id=A. Mesmo embedding e top_k=10 (querer
    // até 10 resultados) — se houvesse leak, chunk B apareceria por similarity.
    type ChunkResult = { chunk_id: string; document_id: string; content: string };
    const results = await sql<ChunkResult[]>`
      SELECT chunk_id, document_id, content
      FROM search_knowledge_chunks_internal(${clinicA.id}::uuid, ${fakeEmbedding}::vector, 10)
    `;

    expect(results.length).toBe(1);
    expect(results[0]?.document_id).toBe(docA.id);
    expect(results[0]?.content).toContain('clínica A');
    expect(results.find((r) => r.content.includes('clínica B'))).toBeUndefined();
  });

  it('escalate_conversation forge: conv de clinic-b + clinic_id de clinic-a → cross-tenant violation', async () => {
    const clinicA = await makeClinic('Xtenant-Esc-A');
    const clinicB = await makeClinic('Xtenant-Esc-B');
    // Setup explícito: AMBAS clinics têm conversation ativa (cenário realista,
    // não só 1 conv existindo). Atacante posicionado em A tenta escalar conv de B.
    const intA = await createTestIntegration(sql, clinicA.id);
    const intB = await createTestIntegration(sql, clinicB.id);
    const convA = await createTestConversation(sql, clinicA.id, intA.id);
    const convB = await createTestConversation(sql, clinicB.id, intB.id);

    await expect(sql`
      SELECT escalate_conversation(${convB.id}::uuid, ${clinicA.id}::uuid, 'forge attempt')
    `).rejects.toThrow(/cross-tenant violation/);

    // Sanity: ambas conversations permanecem inalteradas.
    const states = await sql<{ id: string; state: string; escalated_via: string | null }[]>`
      SELECT id, state, escalated_via FROM conversations WHERE id IN (${convA.id}, ${convB.id})
    `;
    expect(states.find((r) => r.id === convA.id)?.state).toBe('ai_handling');
    expect(states.find((r) => r.id === convB.id)?.state).toBe('ai_handling');
    expect(states.find((r) => r.id === convA.id)?.escalated_via).toBeNull();
    expect(states.find((r) => r.id === convB.id)?.escalated_via).toBeNull();
  });

  // Migration 0019 fix #2 (CodeRabbit critical): is_clinic_member guard inside
  // both transition_conversation_state overloads, scoped to authenticated
  // callers only. service_role bypass preserved (auth.uid() returns NULL).
  it('transition_conversation_state rejects authenticated non-member of conv clinic', async () => {
    const clinicA = await makeClinic('Guard-Auth-A');
    const clinicB = await makeClinic('Guard-Auth-B');
    const userA = await createTestUser(sql);
    createdUserIds.push(userA.id);
    await addUserToClinic(sql, clinicA.id, userA.id);

    const intB = await createTestIntegration(sql, clinicB.id);
    const convB = await createTestConversation(sql, clinicB.id, intB.id);

    // userA está logado e tenta transitar conv que pertence a clinic B.
    await expect(
      getRlsClient(sql, userA.id).query((tx) =>
        tx`SELECT transition_conversation_state(${convB.id}::uuid, 'waiting_human', 'forge')`,
      ),
    ).rejects.toThrow(/cross-tenant violation|caller is not member/i);

    const [row] = await sql<{ state: string; escalated_via: string | null }[]>`
      SELECT state, escalated_via FROM conversations WHERE id = ${convB.id}
    `;
    expect(row?.state).toBe('ai_handling');
    expect(row?.escalated_via).toBeNull();
  });

  it('transition_conversation_state via service_role bypasses guard (auth.uid()=NULL short-circuit)', async () => {
    const clinic = await makeClinic('Guard-ServiceRole');
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    // sql is the service-role client; auth.uid() is NULL, guard short-circuits.
    await sql`
      SELECT transition_conversation_state(${conv.id}::uuid, 'waiting_human', 'service-bypass', 'manual')
    `;
    const [row] = await sql<{ state: string; escalated_via: string }[]>`
      SELECT state, escalated_via FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.state).toBe('waiting_human');
    expect(row?.escalated_via).toBe('manual');
  });

  // Migration 0019 fix #3 (CodeRabbit major): waiting_human always has a
  // non-null escalated_via via COALESCE default to 'manual'.
  it('3-arg transition to waiting_human without flag defaults escalated_via to manual', async () => {
    const clinic = await makeClinic('Default-Manual-3arg');
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    // 3-arg overload — no escalated_via_value. Should default to 'manual'.
    await sql`SELECT transition_conversation_state(${conv.id}::uuid, 'waiting_human', 'no-flag')`;
    const [row] = await sql<{ state: string; escalated_via: string }[]>`
      SELECT state, escalated_via FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.state).toBe('waiting_human');
    expect(row?.escalated_via).toBe('manual');
  });

  it('4-arg transition to waiting_human with NULL flag defaults escalated_via to manual', async () => {
    const clinic = await makeClinic('Default-Manual-4arg');
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    // 4-arg overload com escalated_via_value=NULL — should default to 'manual'.
    await sql`SELECT transition_conversation_state(${conv.id}::uuid, 'waiting_human', 'null-flag', NULL)`;
    const [row] = await sql<{ state: string; escalated_via: string }[]>`
      SELECT state, escalated_via FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.state).toBe('waiting_human');
    expect(row?.escalated_via).toBe('manual');
  });

  // Migration 0020 fix (CodeRabbit re-review major): purge stale 'ai' on
  // legitimate manual reescalations. Atendente assume conv (assigned) então
  // devolve pra fila via 3-arg waiting_human — esperado 'manual', não 'ai'.
  it("stale 'ai' is purged on assigned -> waiting_human via 3-arg (atendente devolve)", async () => {
    const clinic = await makeClinic('Purge-Stale-AI');
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    // 1. IA escala via escalate_conversation: state=waiting_human, escalated_via='ai'
    await sql`SELECT escalate_conversation(${conv.id}::uuid, ${clinic.id}::uuid, 'ia escalou')`;
    const [afterEscalate] = await sql<{ state: string; escalated_via: string }[]>`
      SELECT state, escalated_via FROM conversations WHERE id = ${conv.id}
    `;
    expect(afterEscalate?.escalated_via).toBe('ai');

    // 2. Atendente assume: state=assigned (escalated_via preserved by ELSE branch).
    await sql`SELECT transition_conversation_state(${conv.id}::uuid, 'assigned', 'atendente assumiu')`;
    const [afterAssign] = await sql<{ state: string; escalated_via: string }[]>`
      SELECT state, escalated_via FROM conversations WHERE id = ${conv.id}
    `;
    expect(afterAssign?.state).toBe('assigned');
    expect(afterAssign?.escalated_via).toBe('ai'); // preserved through non-target transition

    // 3. Atendente devolve pra fila via 3-arg waiting_human.
    // Pre-0020: COALESCE(escalated_via, 'manual') = 'ai' (STALE).
    // Post-0020: hard 'manual' — purga origem antiga.
    await sql`SELECT transition_conversation_state(${conv.id}::uuid, 'waiting_human', 'devolveu pra fila')`;
    const [afterReturn] = await sql<{ state: string; escalated_via: string }[]>`
      SELECT state, escalated_via FROM conversations WHERE id = ${conv.id}
    `;
    expect(afterReturn?.state).toBe('waiting_human');
    expect(afterReturn?.escalated_via).toBe('manual'); // KEY assertion

    // 4. Audit row do step 3 deve registrar escalated_via='manual' no `after`
    // (pre-0020, 3-arg só gravava state — agora grava ambos).
    type AuditRow = { metadata: { after: { state: string; escalated_via: string } } };
    const audits = await sql<AuditRow[]>`
      SELECT metadata FROM audit_logs
      WHERE resource_id = ${conv.id}
        AND action = 'conversation.state_changed'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(audits[0]?.metadata.after.state).toBe('waiting_human');
    expect(audits[0]?.metadata.after.escalated_via).toBe('manual');
  });

  // PR-D #15: regression-coverage para o cross-tenant guard interno do
  // collect_info_atomic. Migration 0023 implementou o guard; esse teste
  // garante que qualquer migration futura que mexer na função não
  // enfraqueça a checagem v_clinic IS DISTINCT FROM p_clinic_id. Sem esse
  // guard, um atacante posicionado em clinic-B com referência a um conv_id
  // de clinic-A poderia gravar collected_info na conversa errada.
  it('collect_info_atomic rejects when p_clinic_id != conv.clinic_id (PR-D #15)', async () => {
    const clinicA = await makeClinic('CI-A');
    const clinicB = await makeClinic('CI-B');
    const intA = await createTestIntegration(sql, clinicA.id);
    const convA = await createTestConversation(sql, clinicA.id, intA.id);

    await expect(sql`
      SELECT collect_info_atomic(
        ${convA.id}::uuid,
        ${clinicB.id}::uuid,
        ${'name'}::text,
        ${'2026-05-12T00:00:00Z'}::text
      )
    `).rejects.toThrow(/cross-tenant violation/);

    const [row] = await sql<{ metadata: Record<string, unknown> | null }[]>`
      SELECT metadata FROM conversations WHERE id = ${convA.id}
    `;
    const collected = (row?.metadata as { collected_info?: Record<string, unknown> } | null)
      ?.collected_info;
    expect(collected).toBeUndefined();
  });
});

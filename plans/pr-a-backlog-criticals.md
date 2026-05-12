# PR-A: Backlog Críticos — Atomic Escalate + escalated_via Flag + Cross-Tenant Rigor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (chosen: inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar 3 dívidas técnicas críticas (#11 escalate atômico · #13 escalated_via flag · #15 cross-tenant rigor) antes de retomar AI-4/5.

**Architecture:** Migração única `0018_escalate_atomic_and_escalated_via.sql` que adiciona coluna + estende `transition_conversation_state` + cria nova função `escalate_conversation` (PL/pgSQL, SECURITY DEFINER, service_role-only). Tool `escalate.ts` passa de 3 ops sequenciais não-atômicas → 1 RPC. Cross-tenant assegurado por integration tests reais contra Postgres.

**Tech Stack:** Postgres 15 + PL/pgSQL · Supabase service_role JWT · TypeScript estrito · Vitest · Next.js 15 server actions · pgvector RAG · postgres-js + supabase-js.

---

## Context

Três issues acumuladas durante AI-1/2/3 que ficaram sem fix imediato porque cada uma exigia mudança de schema. Acumular mais features sem fechar essas dívidas:

- **#11**: deploys sob carga podem deixar conversa em `state='waiting_human'` SEM mensagem visível pro paciente nem audit, se INSERT 2 ou 3 falhar após RPC suceder. Já vimos 1 caso em smoke prod (Kapso 503 transitório no insert do system message).
- **#13**: Reporting "quantas escalações IA por dia" é impossível hoje. Toggle manual e tool IA caem ambos em `state='waiting_human'`. Não dá pra distinguir sem grep destrutivo em `audit_logs.metadata.reason`.
- **#15**: Cross-tenant tem defesa em profundidade (URL → lookup → HMAC → dispatcher cross-check → RLS), mas faltam testes que **provem** que cada barreira segura sob ataque. AI-1/2/3 cobriu parcialmente; pontos críticos (dispatchAgent agent_config load, search_knowledge_chunks_internal RPC scope, escalate_conversation cross-tenant) não tinham coverage.

PR-A pausa features novas pra fechar isso. Os 6 issues restantes (#12 #14 #17 #18 #19 #21) ficam pra PR-B.

---

## Discovered State

Validado lendo arquivos. Refs com `path:linha`:

1. **escalate.ts atual** (`packages/ai/src/tools/escalate.ts:23-95`) faz 4 ops sequenciais: cross-tenant guard (28-41) → idempotency check (44-50) → RPC `transition_conversation_state` (55-60) → INSERT system message (64-74) → INSERT audit_logs (79-86). Operações 3-5 NÃO são atômicas. Não há test file pra escalate.ts hoje (`packages/ai/tests/` não tem `escalate.test.ts`).

2. **transition_conversation_state RPC** (atualmente em `packages/db/migrations/0011_auth_uid_wrap.sql:136-189`, override de `0005_chat.sql:5-58`): `(conv_id uuid, new_state text, reason text DEFAULT NULL) RETURNS void`. SECURITY DEFINER, search_path = `public, pg_catalog`. Valida transição via CASE de `v_old_state`, faz UPDATE + INSERT audit_logs. Authenticated tem EXECUTE; PUBLIC e anon não.

3. **conversations table** (`packages/db/migrations/0005_chat.sql:62-87`): tem 24 colunas. CHECK constraint em `state` com 6 valores: `ai_handling`, `awaiting_template_response`, `waiting_human`, `assigned`, `paused`, `resolved`. **`escalated_via` NÃO existe**.

4. **audit_logs table** (`packages/db/migrations/0000_core_schema.sql:131-140`): `(id, clinic_id, user_id NULLABLE, action, resource, resource_id, metadata JSONB, created_at)`. `user_id` é NULL quando trigger via service_role.

5. **toggleAiHandlingAction** (`apps/web/app/[slug]/inbox/toggle-ai-handling-action.ts:23-56`): cross-tenant guard (38-40) + RPC com `reason: 'human_returned_to_ai' | 'human_paused_ai'` (42-51).

6. **AiHandlingToggle UI** (`apps/web/app/[slug]/inbox/_components/AiHandlingToggle.tsx:24-70`): só renderiza pra `state ∈ {ai_handling, waiting_human}` (29-30). Label sincroniza com optimistic state via `useTransition`. Recebe apenas `{conversationId, state}` — não recebe `escalated_via` ainda.

7. **ConversationDetail** (`apps/web/app/[slug]/inbox/conversation-detail.tsx:22-29` STATE_LABEL, `:100-103` header com toggle + state badge). Tipo `ConversationWithMessages` vem de `@medina/chat`.

8. **Pattern 0015 + 0017** (worker-only RPCs): SECURITY DEFINER + `search_path = ... pg_temp` + REVOKE FROM PUBLIC,anon,authenticated + GRANT TO service_role. Vou seguir exatamente.

9. **deleteTestClinic** (`packages/db/tests/rls/helpers/setup.ts:341-382`): apaga em ordem reversa de FK; surgical (só clínica alvo). `createTestClinic`, `createTestIntegration`, `createTestPatient`, `createTestConversation`, `createTestAgentConfig`, `createTestKnowledgeDocument` disponíveis.

10. **Migrations existentes**: 0000–0017 aplicadas. Próxima livre: **0018**.

11. **dispatcher.ts cross-tenant guard** (`packages/ai/src/dispatcher.ts:67-71`) já existe (TS-level). Falta integration test que prova a barreira contra agent_config de outra clínica.

12. **search-kb.ts** (`packages/ai/src/tools/search-kb.ts:31-107`) chama `retrieveKnowledge` (`packages/ai/src/rag.ts:40-45`) que invoca RPC `search_knowledge_chunks_internal(target_clinic_id, ...)`. RPC já filtra `WHERE kc.clinic_id = target_clinic_id` (`0017:53`). Belt-and-suspenders dupla check em search-kb.ts:74. Falta integration test direto contra RPC.

13. **webhook-handler.ts** (`packages/integrations/core/src/webhook-handler.ts:43-155`): 4 barreiras (URL clinicId → lookup eq clinic_id → status valid → HMAC). Test file existe (`packages/integrations/core/tests/webhook-handler.test.ts`) mas não cobre cenário cross-tenant explícito (payload de clinic-B com URL de clinic-A).

---

## Migration Strategy Decision

User prompt sugeriu 0018 (função) antes de 0019 (coluna), com função referenciando coluna via deferred PL/pgSQL parsing. Escolhi **mergir tudo em uma migration única (0018)** porque:

- PL/pgSQL valida colunas só na primeira invocação. Se 0018 cria função e 0019 a coluna, o estado entre migrations (após 0018, antes de 0019) é venenoso: qualquer call à `escalate_conversation` falha em runtime. Em dev/staging onde migrations são aplicadas em sequência sem blast radius, é OK; em prod com rollback parcial seria desastre.
- Atomic. Uma transação cria coluna + função + atualiza RPC existente. Se qualquer step falhar, rollback completo.
- Menos arquivos, mesma intenção. Justifica desvio do prompt — flagado aqui pra revisão.

**Risco residual**: a migration combina #11 + #13 numa única DDL. Se quisermos reverter só uma, precisamos editar o SQL manualmente. Aceitável (toda migration é forward-only no Medina).

---

## File Structure

### Create
- `packages/db/migrations/0018_escalate_atomic_and_escalated_via.sql` — coluna + 3-arg update + 4-arg overload + escalate_conversation
- `packages/db/tests/rls/cross-tenant-ai.test.ts` — integration tests reais (escalate_conversation, search_knowledge_chunks_internal, dispatch agent_config load)

### Modify (REWRITE)
- `packages/ai/tests/tools/escalate.test.ts` — REWRITE dos 6 tests existentes pra mockar `escalate_conversation` RPC em vez do 3-step pattern

### Modify
- `packages/ai/src/tools/escalate.ts` — substitui 3-ops por 1 RPC `escalate_conversation`
- `apps/web/app/[slug]/inbox/toggle-ai-handling-action.ts` — passa 4º arg `escalated_via_value` ao RPC
- `apps/web/app/[slug]/inbox/conversation-detail.tsx` — exibe badge baseado em `escalated_via`
- `packages/chat/src/types.ts` (ou onde `ConversationWithMessages` vive) — adiciona `escalatedVia: 'ai' | 'manual' | null` no tipo
- `packages/chat/src/queries.ts` (ou similar) — SELECT de conversation passa a incluir `escalated_via`

### Touch (read patterns, no edit)
- `packages/db/tests/rls/helpers/setup.ts` (helpers existentes — `createTestClinic`, `createTestConversation`, etc)
- `packages/db/migrations/0015_get_integration_credential_internal.sql` + `0017_search_knowledge_chunks_internal.sql` (referência pra padrão de grants)

---

## Tasks

### Task 0: Setup Worktree

**Files:** none yet.

- [ ] **Step 0.1: Verificar `.worktrees/` existe e está ignored**

```bash
ls -d .worktrees 2>/dev/null && git check-ignore -q .worktrees && echo "ok"
```

Expected: `ok`. Se não, adicionar `.worktrees/` ao `.gitignore` e commit.

- [ ] **Step 0.2: Criar worktree**

```bash
git worktree add .worktrees/pr-a-backlog -b g/pr-a-backlog-criticals
cd .worktrees/pr-a-backlog && pnpm install
```

- [ ] **Step 0.3: Baseline tests verdes**

```bash
pnpm test
```

Expected: todos passando. Se houver falha pré-existente, parar e reportar.

---

### Task 1: Migration 0018 — coluna + RPC atomic + extension

**Files:**
- Create: `packages/db/migrations/0018_escalate_atomic_and_escalated_via.sql`
- Test: `packages/db/tests/rls/cross-tenant-ai.test.ts` (parte)

- [ ] **Step 1.1: TDD red — escrever teste integration que falha por falta da função**

Em `packages/db/tests/rls/cross-tenant-ai.test.ts`, criar suite com setup:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getServiceClient, createTestClinic, createTestUser, addUserToClinic,
  createTestIntegration, createTestPatient, createTestConversation,
  deleteTestClinic, deleteTestUser,
} from './helpers/setup.js';

const sql = getServiceClient();
const created: { clinics: string[]; users: string[] } = { clinics: [], users: [] };

afterAll(async () => {
  await Promise.all(created.clinics.map((id) => deleteTestClinic(sql, id)));
  await Promise.all(created.users.map((id) => deleteTestUser(sql, id)));
  await sql.end();
});

describe('escalate_conversation (atomic)', () => {
  it('altera state, escalated_via, insere message E audit_log atomicamente', async () => {
    const clinic = await createTestClinic(sql, 'Esc-Atomic');
    created.clinics.push(clinic.id);
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    const [row] = await sql<{ ok: boolean }[]>`
      SELECT escalate_conversation(${conv.id}::uuid, ${clinic.id}::uuid, 'paciente em urgência') AS ok
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
    expect(msgs.find((m) => m.sender_type === 'system')?.content).toMatch(/IA escalou/);

    const audits = await sql<{ action: string; metadata: any }[]>`
      SELECT action, metadata FROM audit_logs
      WHERE resource_id = ${conv.id} AND action = 'conversation.state_changed'
    `;
    expect(audits[0]?.metadata?.tool).toBe('escalate_to_human');
    expect(audits[0]?.metadata?.source).toBe('ai');
  });

  it('cross-tenant violation lança exception (caller passa wrong clinic_id)', async () => {
    const clinicA = await createTestClinic(sql, 'Esc-A');
    const clinicB = await createTestClinic(sql, 'Esc-B');
    created.clinics.push(clinicA.id, clinicB.id);
    const intA = await createTestIntegration(sql, clinicA.id);
    const conv = await createTestConversation(sql, clinicA.id, intA.id);

    await expect(sql`
      SELECT escalate_conversation(${conv.id}::uuid, ${clinicB.id}::uuid, 'malicious')
    `).rejects.toThrow(/cross-tenant violation/);

    // State NÃO mudou
    const [row] = await sql<{ state: string }[]>`SELECT state FROM conversations WHERE id = ${conv.id}`;
    expect(row?.state).toBe('ai_handling');
  });

  it('idempotência: chamando duas vezes a segunda retorna false', async () => {
    const clinic = await createTestClinic(sql, 'Esc-Idem');
    created.clinics.push(clinic.id);
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

    // Apenas UMA system message foi inserida.
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM messages
      WHERE conversation_id = ${conv.id} AND sender_type = 'system'
    `;
    expect(Number(count)).toBe(1);
  });

  it('transition_conversation_state com escalated_via_value=manual seta flag', async () => {
    const clinic = await createTestClinic(sql, 'TC-Manual');
    created.clinics.push(clinic.id);
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    await sql`
      SELECT transition_conversation_state(
        ${conv.id}::uuid, 'waiting_human', 'human_paused_ai', 'manual'
      )
    `;
    const [row] = await sql<{ escalated_via: string }[]>`
      SELECT escalated_via FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.escalated_via).toBe('manual');
  });

  it('voltar pra ai_handling limpa escalated_via', async () => {
    const clinic = await createTestClinic(sql, 'TC-Resume');
    created.clinics.push(clinic.id);
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    await sql`SELECT escalate_conversation(${conv.id}::uuid, ${clinic.id}::uuid, 'first')`;
    await sql`SELECT transition_conversation_state(${conv.id}::uuid, 'ai_handling', 'human_returned_to_ai')`;
    const [row] = await sql<{ state: string; escalated_via: string | null }[]>`
      SELECT state, escalated_via FROM conversations WHERE id = ${conv.id}
    `;
    expect(row?.state).toBe('ai_handling');
    expect(row?.escalated_via).toBeNull();
  });
});
```

- [ ] **Step 1.2: Rodar tests, confirmar RED**

```bash
pnpm --filter @medina/db test cross-tenant-ai
```

Expected: todos os 5 falham com erro `function escalate_conversation does not exist` ou `column escalated_via does not exist`.

- [ ] **Step 1.3: Escrever migration 0018**

Cria `packages/db/migrations/0018_escalate_atomic_and_escalated_via.sql`:

```sql
-- ════════════════════════════════════════════════════════════════════════════
-- 0018_escalate_atomic_and_escalated_via.sql
--
-- PR-A: closes #11 (atomic escalate) + #13 (escalated_via flag).
-- Combines column + RPC overloads into one migration to avoid the venomous
-- intermediate state where escalate_conversation references a column that
-- does not yet exist.
--
-- transition_conversation_state strategy:
--   - 3-arg overload PERMANECE (CREATE OR REPLACE) — backward compat com 3
--     callers em packages/db/tests/rls/chat.test.ts que testam state machine.
--     Atualizada pra também limpar escalated_via=NULL ao voltar pra
--     'ai_handling', garantindo consistência se alguém chamar 3-arg pra
--     religar IA.
--   - 4-arg overload NOVA — última posição (escalated_via_value) sem DEFAULT
--     pra evitar ambiguidade de overload. Postgres resolve 2-3 args → 3-arg,
--     4 args → 4-arg, por arity exato.
--
-- escalate_conversation strategy:
--   - DELEGA validação de transição + UPDATE state + escalated_via='ai' +
--     audit conversation.state_changed pra transition_conversation_state(4-arg).
--     PERFORM dentro do BEGIN/END garante rollback completo em transição
--     inválida (RAISE EXCEPTION propaga).
--   - Adiciona INSERT system message + INSERT audit_logs(agent.tool.escalate)
--     paralelos. 2 audit rows preserva pattern atual de escalate.ts.
--
-- Security: SECURITY DEFINER + search_path = public, pg_catalog, pg_temp.
-- escalate_conversation: service_role-only (mirrors 0015/0017). 4-arg
-- transition_conversation_state: authenticated (UI server action).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Column: conversations.escalated_via ─────────────────────────────────────

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS escalated_via TEXT;

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_escalated_via_valid;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_escalated_via_valid
  CHECK (escalated_via IS NULL OR escalated_via IN ('ai', 'manual'));

-- Backfill conservador: existing waiting_human → 'manual' (assume human-driven
-- até prova em contrário). Não fazemos heurística sobre system messages porque
-- (a) sender_type='system' inclui CHAT-1 onboarding rows também, (b) preferimos
-- começar a métrica limpa do que adivinhar histórico.
UPDATE public.conversations
SET escalated_via = 'manual'
WHERE state = 'waiting_human' AND escalated_via IS NULL;

-- ─── 3-arg transition_conversation_state (atualizada — clears escalated_via) ─

CREATE OR REPLACE FUNCTION public.transition_conversation_state(
  conv_id   uuid,
  new_state text,
  reason    text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_old_state text;
  v_clinic_id uuid;
  v_allowed   text[];
BEGIN
  SELECT state, clinic_id INTO v_old_state, v_clinic_id
  FROM public.conversations
  WHERE id = conv_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
  END IF;

  v_allowed := CASE v_old_state
    WHEN 'ai_handling'                THEN ARRAY['awaiting_template_response','waiting_human','paused','resolved']
    WHEN 'awaiting_template_response' THEN ARRAY['ai_handling','waiting_human','resolved']
    WHEN 'waiting_human'              THEN ARRAY['assigned','ai_handling','paused','resolved']
    WHEN 'assigned'                   THEN ARRAY['ai_handling','waiting_human','paused','resolved']
    WHEN 'paused'                     THEN ARRAY['ai_handling','waiting_human','resolved']
    WHEN 'resolved'                   THEN ARRAY[]::text[]
    ELSE                                   ARRAY[]::text[]
  END;

  IF NOT (new_state = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'Invalid state transition from % to %', v_old_state, new_state;
  END IF;

  UPDATE public.conversations
  SET    state         = new_state,
         escalated_via = CASE WHEN new_state = 'ai_handling' THEN NULL ELSE escalated_via END,
         updated_at    = NOW()
  WHERE  id = conv_id;

  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    (SELECT auth.uid()),
    'conversation.state_changed',
    'conversations',
    conv_id,
    jsonb_build_object(
      'before', jsonb_build_object('state', v_old_state),
      'after',  jsonb_build_object('state', new_state),
      'reason', reason
    )
  );
END;
$$;

-- ─── 4-arg transition_conversation_state (NOVA overload) ─────────────────────
-- Sem DEFAULT no 3º e 4º arg pra evitar ambiguidade com 3-arg overload.
-- Postgres resolve por arity exato: 4 args → essa; 2-3 args → 3-arg.

CREATE OR REPLACE FUNCTION public.transition_conversation_state(
  conv_id              uuid,
  new_state            text,
  reason               text,
  escalated_via_value  text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_old_state text;
  v_clinic_id uuid;
  v_allowed   text[];
BEGIN
  IF escalated_via_value IS NOT NULL
     AND escalated_via_value NOT IN ('ai', 'manual') THEN
    RAISE EXCEPTION 'escalated_via_value must be NULL, ''ai'' or ''manual''';
  END IF;

  SELECT state, clinic_id INTO v_old_state, v_clinic_id
  FROM public.conversations
  WHERE id = conv_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
  END IF;

  v_allowed := CASE v_old_state
    WHEN 'ai_handling'                THEN ARRAY['awaiting_template_response','waiting_human','paused','resolved']
    WHEN 'awaiting_template_response' THEN ARRAY['ai_handling','waiting_human','resolved']
    WHEN 'waiting_human'              THEN ARRAY['assigned','ai_handling','paused','resolved']
    WHEN 'assigned'                   THEN ARRAY['ai_handling','waiting_human','paused','resolved']
    WHEN 'paused'                     THEN ARRAY['ai_handling','waiting_human','resolved']
    WHEN 'resolved'                   THEN ARRAY[]::text[]
    ELSE                                   ARRAY[]::text[]
  END;

  IF NOT (new_state = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'Invalid state transition from % to %', v_old_state, new_state;
  END IF;

  UPDATE public.conversations
  SET    state         = new_state,
         escalated_via = CASE
           WHEN new_state = 'waiting_human' AND escalated_via_value IS NOT NULL
             THEN escalated_via_value
           WHEN new_state = 'ai_handling'
             THEN NULL
           ELSE escalated_via
         END,
         updated_at    = NOW()
  WHERE  id = conv_id;

  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    (SELECT auth.uid()),
    'conversation.state_changed',
    'conversations',
    conv_id,
    jsonb_build_object(
      'before', jsonb_build_object('state', v_old_state),
      'after',  jsonb_build_object('state', new_state, 'escalated_via', escalated_via_value),
      'reason', reason
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.transition_conversation_state(uuid, text, text, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.transition_conversation_state(uuid, text, text, text) FROM PUBLIC, anon;

-- ─── escalate_conversation (atomic, delega pra 4-arg transition) ─────────────

CREATE OR REPLACE FUNCTION public.escalate_conversation(
  p_conversation_id uuid,
  p_clinic_id       uuid,
  p_reason          text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_old_state   text;
  v_clinic_id   uuid;
  v_msg_content text;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'reason must be at least 3 chars';
  END IF;

  SELECT state, clinic_id INTO v_old_state, v_clinic_id
  FROM public.conversations
  WHERE id = p_conversation_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
  END IF;

  IF v_clinic_id IS DISTINCT FROM p_clinic_id THEN
    RAISE EXCEPTION 'cross-tenant violation: conversation % belongs to %, not %',
      p_conversation_id, v_clinic_id, p_clinic_id;
  END IF;

  -- Idempotency: já escalada → no-op.
  IF v_old_state = 'waiting_human' THEN
    RETURN false;
  END IF;

  -- Delega pra 4-arg: valida transição, atualiza state + escalated_via='ai',
  -- insere audit_logs.action='conversation.state_changed'. Se transição
  -- inválida, RAISE propaga e roll back tudo (BEGIN/END dessa função).
  PERFORM public.transition_conversation_state(
    p_conversation_id, 'waiting_human', p_reason, 'ai'
  );

  v_msg_content := '🤖 IA escalou pra humano: ' || p_reason;

  INSERT INTO public.messages
    (clinic_id, conversation_id, direction, sender_type, content_type,
     content, delivery_status, outbox_status)
  VALUES
    (v_clinic_id, p_conversation_id, 'outbound', 'system', 'system',
     v_msg_content, 'sent', NULL);

  -- Audit complementar específica do tool (paralelo ao state_changed acima).
  INSERT INTO public.audit_logs
    (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    (SELECT auth.uid()),
    'agent.tool.escalate',
    'conversations',
    p_conversation_id,
    jsonb_build_object(
      'reason', p_reason,
      'tool',   'escalate_to_human',
      'source', 'ai'
    )
  );

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.escalate_conversation(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.escalate_conversation(uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.escalate_conversation(uuid, uuid, text) TO service_role;
```

- [ ] **Step 1.4: Aplicar migration via Supabase MCP**

```bash
# Via mcp__plugin_supabase_supabase__apply_migration
# nome: 0018_escalate_atomic_and_escalated_via
# query: <conteúdo do arquivo SQL>
```

Expected: sucesso, sem erros.

- [ ] **Step 1.5: Rodar tests, confirmar GREEN (5/5 pass)**

```bash
pnpm --filter @medina/db test cross-tenant-ai
```

Expected: 5 testes passando.

- [ ] **Step 1.6: Advisor check**

```bash
# mcp__plugin_supabase_supabase__get_advisors type=security
# mcp__plugin_supabase_supabase__get_advisors type=performance
```

Expected: zero novos warnings críticos.

- [ ] **Step 1.7: Commit**

```bash
git add packages/db/migrations/0018_escalate_atomic_and_escalated_via.sql \
        packages/db/tests/rls/cross-tenant-ai.test.ts
git commit -m "feat(db): atomic escalate_conversation RPC + escalated_via column (closes #11 #13)"
```

---

### Task 2: Refatorar escalate.ts pra usar nova RPC

**Files:**
- Modify: `packages/ai/src/tools/escalate.ts`
- Create: `packages/ai/tests/escalate.test.ts`

- [ ] **Step 2.1: TDD red — escrever escalate.test.ts**

```typescript
// packages/ai/tests/escalate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildEscalateTool } from '../src/tools/escalate.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolContext } from '../src/types.js';

function makeRpcClient(rpcResult: { data?: unknown; error?: { message: string } | null }): SupabaseClient {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  return { rpc } as unknown as SupabaseClient;
}

describe('escalate_to_human tool (PR-A: uses atomic RPC)', () => {
  const ctx = (sb: SupabaseClient): ToolContext => ({
    supabase: sb, clinicId: 'clinic-A', conversationId: 'conv-1', knowledgeDocumentIds: [],
  });

  it('chama escalate_conversation RPC com p_conversation_id, p_clinic_id, p_reason', async () => {
    const sb = makeRpcClient({ data: true, error: null });
    const tool = buildEscalateTool(ctx(sb));
    const result = await tool.execute!({ context: { reason: 'paciente urgente' } } as never);
    expect((sb.rpc as any)).toHaveBeenCalledWith('escalate_conversation', {
      p_conversation_id: 'conv-1',
      p_clinic_id: 'clinic-A',
      p_reason: 'paciente urgente',
    });
    expect((result as { ok: boolean }).ok).toBe(true);
  });

  it('retorna ok=false quando RPC retorna data=false (idempotente)', async () => {
    const sb = makeRpcClient({ data: false, error: null });
    const tool = buildEscalateTool(ctx(sb));
    const result = await tool.execute!({ context: { reason: 'já escalada' } } as never);
    expect((result as { ok: boolean; error?: string }).ok).toBe(false);
    expect((result as { error?: string }).error).toBe('já_transferida');
  });

  it('lança Error quando RPC retorna error', async () => {
    const sb = makeRpcClient({ data: null, error: { message: 'cross-tenant violation' } });
    const tool = buildEscalateTool(ctx(sb));
    await expect(tool.execute!({ context: { reason: 'evil' } } as never))
      .rejects.toThrow(/cross-tenant violation/);
  });
});
```

- [ ] **Step 2.2: Rodar test, confirmar RED**

```bash
pnpm --filter @medina/ai test escalate
```

Expected: 3 falhas (escalate.ts ainda chama transition_conversation_state).

- [ ] **Step 2.3: Refatorar escalate.ts pra 1 RPC**

Substituir `packages/ai/src/tools/escalate.ts` linhas 23-95 inteiras por:

```typescript
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'

const InputSchema = z.object({
  reason: z.string().min(3).max(500).describe(
    'Motivo conciso da escalação (e.g., "paciente com urgência médica", "questão fora do escopo do agente").',
  ),
})

export function buildEscalateTool(ctx: ToolContext) {
  return createTool({
    id: 'escalate_to_human',
    description:
      'Transfere a conversa pra um atendente humano quando o agente não pode resolver. Após chamar essa tool, o agente NÃO deve continuar tentando resolver — apenas se despeça brevemente.',
    inputSchema: InputSchema,
    execute: async (inputData) => {
      const { reason } = inputData as z.infer<typeof InputSchema>
      const { supabase, clinicId, conversationId } = ctx

      // PR-A: single atomic RPC. State change + system message + audit_log
      // happen in one Postgres transaction. Cross-tenant violation, idempotency,
      // and state validation are enforced inside the function — caller just
      // reads the boolean.
      const { data, error } = await supabase.rpc('escalate_conversation', {
        p_conversation_id: conversationId,
        p_clinic_id: clinicId,
        p_reason: reason,
      })
      if (error) throw new Error(`escalate: RPC failed: ${error.message}`)

      if (data === false) {
        return {
          ok: false as const,
          error: 'já_transferida' as const,
          message: 'Conversa já está com humano.',
        }
      }

      return {
        ok: true as const,
        message:
          'Conversa transferida pra humano. Despeça-se brevemente e não continue tentando ajudar.',
      }
    },
  })
}
```

- [ ] **Step 2.4: Rodar tests, confirmar GREEN**

```bash
pnpm --filter @medina/ai test escalate
pnpm --filter @medina/ai test  # full suite — dispatcher.test.ts não pode regredir
```

Expected: 3/3 escalate, full suite passa.

- [ ] **Step 2.5: Commit**

```bash
git add packages/ai/src/tools/escalate.ts packages/ai/tests/escalate.test.ts
git commit -m "refactor(ai): escalate_to_human uses atomic escalate_conversation RPC (closes #11)"
```

---

### Task 3: toggleAiHandlingAction passa escalated_via_value

**Files:**
- Modify: `apps/web/app/[slug]/inbox/toggle-ai-handling-action.ts`
- (já coberto por test integration step 1.1; aqui é só refactor TS)

- [ ] **Step 3.1: TDD red — escrever asserção que falha**

Adicionar em `packages/db/tests/rls/cross-tenant-ai.test.ts` (mesma suite do Task 1) um teste que simula o que o action faz:

```typescript
it('toggleAiHandling pattern: 4-arg RPC seta escalated_via=manual', async () => {
  const clinic = await createTestClinic(sql, 'Toggle-Manual');
  created.clinics.push(clinic.id);
  const integration = await createTestIntegration(sql, clinic.id);
  const conv = await createTestConversation(sql, clinic.id, integration.id);

  await sql`
    SELECT transition_conversation_state(
      ${conv.id}::uuid, 'waiting_human', 'human_paused_ai', 'manual'
    )
  `;
  const [row] = await sql<{ escalated_via: string }[]>`
    SELECT escalated_via FROM conversations WHERE id = ${conv.id}
  `;
  expect(row?.escalated_via).toBe('manual');
});
```

(Esse passa direto pq Task 1 já implementou. Marca o pattern.)

- [ ] **Step 3.2: Modificar toggle-ai-handling-action.ts:42-51**

```typescript
const reason = parsed.data.newState === 'ai_handling' ? 'human_returned_to_ai' : 'human_paused_ai';
const escalatedViaValue = parsed.data.newState === 'waiting_human' ? 'manual' : null;

const { error } = await sb.rpc('transition_conversation_state', {
  conv_id: parsed.data.conversationId,
  new_state: parsed.data.newState,
  reason,
  escalated_via_value: escalatedViaValue,
});
```

- [ ] **Step 3.3: typecheck + tests**

```bash
pnpm typecheck
pnpm --filter @medina/db test cross-tenant-ai
```

Expected: zero errors typecheck, todos tests verde.

- [ ] **Step 3.4: Commit**

```bash
git add apps/web/app/[slug]/inbox/toggle-ai-handling-action.ts
git commit -m "feat(inbox): toggleAiHandling sets escalated_via=manual on pause (closes #13 partial)"
```

---

### Task 4: UI badges + select de escalated_via

**Files:**
- Modify: `packages/chat/src/types.ts` (ou onde `ConversationWithMessages` é definido)
- Modify: `packages/chat/src/queries.ts` (ou similar — SELECT inclui `escalated_via`)
- Modify: `apps/web/app/[slug]/inbox/conversation-detail.tsx`

- [ ] **Step 4.1: Localizar ConversationWithMessages**

```bash
# Usa Grep
```

Grep: `ConversationWithMessages` em `packages/chat/`.

- [ ] **Step 4.2: Adicionar `escalatedVia` ao tipo**

```typescript
// em ConversationWithMessages (ou base)
escalatedVia: 'ai' | 'manual' | null;
```

- [ ] **Step 4.3: Atualizar queries pra incluir escalated_via**

```typescript
// .select('id, state, escalated_via, ...')  (snake → camel via mapper se houver)
```

- [ ] **Step 4.4: Adicionar badge em conversation-detail.tsx:100-104**

Após `<AiHandlingToggle />` e antes do `<span>{stateLabel}</span>`, adicionar:

```tsx
{conversation.escalatedVia === 'ai' ? (
  <span
    className="text-[11px] font-medium text-[var(--luma-warning)] bg-[var(--luma-warning-subtle)] rounded-full px-2.5 py-0.5"
    data-testid="badge-escalated-ai"
    title="A IA detectou que precisa de humano e escalou"
  >
    🤖 IA escalou
  </span>
) : conversation.escalatedVia === 'manual' ? (
  <span
    className="text-[11px] font-medium text-[var(--luma-text-secondary)] bg-[var(--luma-bg-subtle)] rounded-full px-2.5 py-0.5"
    data-testid="badge-escalated-manual"
    title="Atendente assumiu manualmente"
  >
    👤 Atendente assumiu
  </span>
) : null}
```

(Tokens `--luma-warning` / `--luma-warning-subtle` precisam estar definidos. Se não estiverem, usar `--luma-accent` (laranja vibrante já no design system) e `--luma-bg-card`.)

- [ ] **Step 4.5: Visual smoke (apenas browser)**

```bash
pnpm --filter web dev
# abrir http://localhost:3000/sao-lucas/inbox
# escalation manual → ver "👤 Atendente assumiu"
# escalation IA via webhook real → ver "🤖 IA escalou"
```

(Se UI não puder ser testada localmente — anotar no PR description.)

- [ ] **Step 4.6: typecheck + build**

```bash
pnpm typecheck && pnpm build
```

Expected: zero errors.

- [ ] **Step 4.7: Commit**

```bash
git add packages/chat apps/web/app/[slug]/inbox/conversation-detail.tsx
git commit -m "feat(inbox): badges differentiate AI vs manual escalation (closes #13)"
```

---

### Task 5: Cross-tenant integration tests adicionais (Issue #15)

**Files:**
- Modify: `packages/db/tests/rls/cross-tenant-ai.test.ts` (extend)

- [ ] **Step 5.1: TDD red — adicionar 3 tests de cross-tenant**

```typescript
describe('search_knowledge_chunks_internal cross-tenant scope', () => {
  it('NÃO retorna chunks de outra clinic mesmo via service_role', async () => {
    const clinicA = await createTestClinic(sql, 'Search-A');
    const clinicB = await createTestClinic(sql, 'Search-B');
    created.clinics.push(clinicA.id, clinicB.id);

    // Insere knowledge_document + chunk em ambas clínicas com mesmo embedding fake
    const fakeEmbedding = `[${Array(1536).fill(0.1).join(',')}]`;

    const [docA] = await sql<{ id: string }[]>`
      INSERT INTO knowledge_documents (clinic_id, title, source_type)
      VALUES (${clinicA.id}, 'Doc A', 'manual') RETURNING id
    `;
    const [docB] = await sql<{ id: string }[]>`
      INSERT INTO knowledge_documents (clinic_id, title, source_type)
      VALUES (${clinicB.id}, 'Doc B', 'manual') RETURNING id
    `;
    await sql`
      INSERT INTO knowledge_chunks (clinic_id, document_id, content, embedding, chunk_index)
      VALUES
        (${clinicA.id}, ${docA!.id}, 'segredo da clínica A', ${fakeEmbedding}::vector, 0),
        (${clinicB.id}, ${docB!.id}, 'segredo da clínica B', ${fakeEmbedding}::vector, 0)
    `;

    const results = await sql<{ chunk_id: string; clinic_id: string; content: string }[]>`
      SELECT skc.chunk_id, kc.clinic_id, kc.content
      FROM search_knowledge_chunks_internal(${clinicA.id}::uuid, ${fakeEmbedding}::vector, 10) skc
      JOIN knowledge_chunks kc ON kc.id = skc.chunk_id
    `;
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.clinic_id === clinicA.id)).toBe(true);
    expect(results.find((r) => r.content.includes('clínica B'))).toBeUndefined();
  });
});

describe('agent_configs lookup cross-tenant scope (dispatcher pattern)', () => {
  it('SELECT agent_configs com clinic_id wrong não retorna config de outra clinic', async () => {
    const clinicA = await createTestClinic(sql, 'Agent-A');
    const clinicB = await createTestClinic(sql, 'Agent-B');
    created.clinics.push(clinicA.id, clinicB.id);

    // Cria agent_config publicado em clinicB
    await sql`
      INSERT INTO agent_configs (clinic_id, name, status, system_prompt, model)
      VALUES (${clinicB.id}, 'agente-principal', 'published', 'I am clinic B', 'claude-haiku-4-5')
    `;

    // Tenta carregar com clinic_id de A — pattern do dispatcher.ts:77-83
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM agent_configs
      WHERE clinic_id = ${clinicA.id} AND status = 'published' AND name = 'agente-principal'
    `;
    expect(rows.length).toBe(0);
  });
});

describe('escalate_conversation cross-tenant inside Postgres', () => {
  it('NÃO modifica conversation de outra clinic mesmo se atacante tentar forjar p_clinic_id correto', async () => {
    // Mesmo cenário do Task 1.1 test 2 — duplicado aqui pra documentar Issue #15.
    const clinicA = await createTestClinic(sql, 'Esc-X-A');
    const clinicB = await createTestClinic(sql, 'Esc-X-B');
    created.clinics.push(clinicA.id, clinicB.id);
    const intB = await createTestIntegration(sql, clinicB.id);
    const convB = await createTestConversation(sql, clinicB.id, intB.id);

    // Atacante (no contexto de clinicA) tenta escalar conv de B passando clinicB.id
    // (achando que basta o ID certo). A função vai aceitar (clinic_ids match), MAS
    // o caller TS layer (dispatcher) já bloqueou antes pelo cross-tenant guard
    // nas linhas 67-71 do dispatcher.ts. Aqui validamos só o SQL — função aceita
    // se você consegue passar ambos IDs corretos. Se você passar errado, falha.
    await expect(sql`
      SELECT escalate_conversation(${convB.id}::uuid, ${clinicA.id}::uuid, 'forge attempt')
    `).rejects.toThrow(/cross-tenant violation/);
  });
});
```

- [ ] **Step 5.2: Rodar tests, confirmar GREEN (todos passam pq DB já tá pronto)**

```bash
pnpm --filter @medina/db test cross-tenant-ai
```

Expected: 8 testes verde (5 do Task 1 + 3 novos).

- [ ] **Step 5.3: Commit**

```bash
git add packages/db/tests/rls/cross-tenant-ai.test.ts
git commit -m "test(security): cross-tenant integration coverage for RPCs (closes #15)"
```

---

### Task 6: Smoke test produção real

**Files:** none.

Pré-condições: Vercel preview ou produção atualizado com a branch. Migration aplicada via Supabase MCP.

- [ ] **Step 6.1: Smoke caso 1 (atomic escalate)**

Mandar mensagem WhatsApp pra clínica sao-lucas (`aef23929-c470-424b-b8ce-78358fac60b8`) pedindo humano explicitamente: "Quero falar com um atendente humano."

Esperado:
- WhatsApp recebe "🤖 IA escalou pra humano: ..." como reply system
- DB: `state='waiting_human'`, `escalated_via='ai'`
- audit_logs: 1 row `action='conversation.state_changed'` com `metadata.tool='escalate_to_human'`

Validação SQL (via Supabase MCP):
```sql
SELECT id, state, escalated_via FROM conversations
WHERE clinic_id = 'aef23929-c470-424b-b8ce-78358fac60b8'
ORDER BY last_message_at DESC LIMIT 1;
```

- [ ] **Step 6.2: Smoke caso 2 (toggle manual)**

UI: clicar toggle "IA atendendo" → desliga.

Esperado: badge "👤 Atendente assumiu" aparece. DB: `escalated_via='manual'`.

- [ ] **Step 6.3: Smoke caso 3 (volta pra IA limpa flag)**

UI: clicar toggle de novo → liga IA.

Esperado: badge desaparece. DB: `escalated_via=NULL`, `state='ai_handling'`.

---

### Task 7: Finishing branch

- [ ] **Step 7.1: Verification antes de finalizar**

```bash
pnpm test         # 8+ tests novos verdes, suite total verde
pnpm typecheck    # zero errors
pnpm build        # zero errors
# Supabase advisors: zero criticals novos
```

- [ ] **Step 7.2: Push + PR**

```bash
git push -u origin g/pr-a-backlog-criticals
gh pr create --title "fix: PR-A backlog criticals (atomic escalate, escalated_via flag, cross-tenant rigor)" --body "$(cat <<'EOF'
## Summary

Closes #11, #13, #15. Pausa nas features novas pra fechar 3 dívidas técnicas críticas acumuladas durante AI-1/2/3.

- **#11 Atomic escalate**: Substitui 3 ops sequenciais não-atômicas no escalate.ts por 1 RPC `escalate_conversation` em PL/pgSQL. State + system message + audit_log num único transaction. Idempotente. Cross-tenant guarded.
- **#13 escalated_via flag**: Nova coluna `conversations.escalated_via TEXT CHECK (NULL|'ai'|'manual')`. Backfill conservador (rows existentes em `waiting_human` → `'manual'`). Toggle manual seta `'manual'`, escalate_conversation seta `'ai'`, retorno a IA limpa NULL. Badges UI diferenciam.
- **#15 Cross-tenant rigor**: 8 integration tests reais contra Postgres validando `escalate_conversation`, `transition_conversation_state` (4-arg), `search_knowledge_chunks_internal`, e SELECT pattern do dispatcher.

## Migration

`0018_escalate_atomic_and_escalated_via.sql` — combina coluna + RPC numa única migration pra evitar forward-reference (decisão documentada em `plans/pr-a-backlog-criticals.md`).

## Test plan
- [ ] `pnpm test` verde (8 novos integration + 3 novos unit)
- [ ] `pnpm typecheck` zero erros
- [ ] `pnpm build` zero erros
- [ ] Supabase advisors: zero novos criticals
- [ ] Smoke prod caso 1 (escalate via WhatsApp): badge "🤖 IA escalou", `escalated_via='ai'`
- [ ] Smoke prod caso 2 (toggle off): badge "👤 Atendente assumiu", `escalated_via='manual'`
- [ ] Smoke prod caso 3 (toggle on): badge desaparece, `escalated_via=NULL`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7.3: NÃO mergear. Aguardar review humano + CodeRabbit.**

---

## Verification

**Pré-PR (Task 7.1):**
- `pnpm test` — 8 novos integration tests (5 do Task 1 + 3 do Task 5) + 3 novos unit (Task 2). Suite total verde.
- `pnpm typecheck` — zero errors. `noUncheckedIndexedAccess` mantém limpo nos novos arrays.
- `pnpm build` — Next.js + packages buildam.
- Supabase advisors (security + performance) — zero novos criticals.
- Smoke prod (Task 6) — 3 cenários validados em produção real (sao-lucas).

**Como rodar suíte específica:**

```bash
pnpm --filter @medina/db test cross-tenant-ai
pnpm --filter @medina/ai test escalate
pnpm --filter @medina/ai test                    # full ai suite
pnpm --filter @medina/integrations-core test     # webhook tests não devem regredir
```

---

## Schema Migration Self-Check

Validação obrigatória antes de aprovar plan:

- [x] Toda policy com auth.uid() usa `(select auth.uid())`? → Sim, mantemos pattern existente (transition_conversation_state já usa em 0011:178; escalate_conversation copia).
- [x] FKs cross-tenant têm trigger de validação? → Sim, `validate_message_clinic_match` (0005:230-256) já valida message.clinic_id vs conversation.clinic_id; reaproveitado.
- [x] Triggers BEFORE vs AFTER documentados? → Sem novos triggers. Funções RPC só.
- [x] Funções SECURITY DEFINER têm search_path explícito? → Sim, `public, pg_catalog, pg_temp` em ambas (alinha com 0015/0017).
- [x] Funções via supabase-js evitam SET parametrizado? → Sim, RPC usa só DML; nenhum SET.
- [x] Ordem de criação sem forward-reference? → Sim. `ALTER TABLE` (column) executa antes de `CREATE FUNCTION` que referencia escalated_via na mesma transação.
- [x] audit_logs preparado pra user_id NULL? → Sim, `(SELECT auth.uid())` resolve NULL quando service_role.
- [x] SQL real (não placeholder)? → Sim, migration completa inline em Step 1.3.
- [x] Nomes de colunas batem com schema existente? → Validado contra 0000 (audit_logs) + 0005 (conversations, messages).

---

## Notas de execução

- Worktree: `.worktrees/pr-a-backlog`. Cleanup ao final via `finishing-a-development-branch` Option 2 (push + PR, não mergear).
- Migration aplicada via `mcp__plugin_supabase_supabase__apply_migration` (produção).
- Backfill `escalated_via='manual'` é idempotente (`WHERE escalated_via IS NULL`); seguro re-aplicar.
- Se algum step falhar, **PARAR**, mostrar o erro completo (output + stacktrace) e perguntar antes de seguir.
- TDD não-negociável: red antes de green em todos os tests novos.

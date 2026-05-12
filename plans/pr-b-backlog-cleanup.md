# PR-B Backlog Cleanup — Implementation Plan

> **Sub-skill:** `superpowers:executing-plans` (INLINE). Sub-tasks com checkboxes `- [ ]`.

**Goal:** Liquidar 5 issues de follow-up pequenas/médias dos PRs AI-1/2/3 + corrigir typecheck pré-existente do iclinic. Após este PR, backlog técnico do agente IA fica limpo, exceto issue #21 (per-clinic kb threshold) que vai como PR-C separado.

**Architecture:** Sem mudança arquitetural. 1 nova RPC (atomic collect_info), 1 ajuste de schema Drizzle, fortalecimento de 3 workers (idempotência + cross-tenant + timeout), e fix de tsconfig do iclinic.

**Tech Stack:** Mesma — TypeScript estrito, Vitest, PostgreSQL/Supabase, Mastra Agent.

---

## Context

PR-A fechou issues #11, #13, #15. PR #24 (AI-5 guardrails) foi aberto e está em review. Restante do backlog pré-existente são **5 issues "follow-up"** identificadas em CodeRabbit reviews dos AI-1/2/3 + 1 falha de typecheck no `@medina/integrations-pep-iclinic` herdada.

Risco baixo individualmente; juntar num PR único reduz overhead de review/CI.

---

## File Structure

**Create:**
- `packages/db/migrations/0023_collect_info_atomic.sql` — RPC `collect_info_atomic` (issue #12)
- `packages/ai/tests/tools/collect-info.atomic.test.ts` — race condition coverage
- `packages/db/tests/rls/collect-info-rpc.test.ts` — atomic + cross-tenant

**Modify:**
- `packages/ai/src/tools/collect-info.ts` — usar RPC atomic em vez de read-modify-write
- `packages/db/src/schema/clinics.ts` — `businessHours.notNull().default({})` (issue #14)
- `packages/ai/src/seed-kb.ts` — checar `status='processing'` no idempotency lookup; manter zombie só re-corre se aplicável (issue #17)
- `apps/web/lib/inngest/functions/reindex-document.ts` — SELECT clinic_id + comparar com event payload (issue #18)
- `packages/ai/src/embeddings.ts` — `new OpenAI({ apiKey, timeout: 30_000, maxRetries: 2 })` (issue #19)
- `packages/integrations/pep/iclinic/tsconfig.json` — adicionar `"jsx": "preserve"` + paths apropriados; OU restringir `include` pra não vazar de apps/web

**Won't change:**
- `packages/ai/src/dispatcher.ts` (sem mudança comportamental)
- `packages/db/migrations/0001-0022` (forward-only)
- AI-5 guardrails (PR #24)

---

## Tasks

### Task 0: Worktree + branch

- [ ] **0.1** Criar worktree `.worktrees/pr-b-backlog-cleanup`, branch `g/pr-b-backlog-cleanup`, base `main` (post-merge AI-5)
- [ ] **0.2** `pnpm install` no worktree, copiar `.env.local` da main
- [ ] **0.3** Baseline tests: `@medina/ai`, `@medina/db`, `@medina/web`, `@medina/chat` todos verdes (deve ser ~444 testes pós-merge AI-5)

### Task 1: Issue #19 — OpenAI embeddings timeout/maxRetries (trivial)

- [ ] **1.1** RED — adicionar `packages/ai/tests/embeddings.test.ts` test "OpenAI client constructed with timeout=30s + maxRetries=2"
- [ ] **1.2** Run → FAIL (sem timeout config)
- [ ] **1.3** Modificar `packages/ai/src/embeddings.ts:1-22`:
  ```ts
  const client = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'],
    timeout: 30_000,  // 30s — Inngest workflow tem 60s; deixa headroom
    maxRetries: 2,    // SDK default é 2 mas explicito
  })
  ```
- [ ] **1.4** Run → PASS
- [ ] **1.5** Commit: `fix(ai): OpenAI embeddings client timeout 30s + explicit maxRetries (#19)`

### Task 2: Issue #14 — Drizzle businessHours default (trivial)

- [ ] **2.1** Modificar `packages/db/src/schema/clinics.ts:14`:
  ```ts
  businessHours: jsonb('business_hours').notNull().default({}),
  ```
- [ ] **2.2** Run `pnpm --filter @medina/db typecheck` → confirma `NewClinic` agora aceita omitir field
- [ ] **2.3** Sem migration nova (DB-level default já existe via 0007_pipeline ou similar; Drizzle só precisa concordar)
- [ ] **2.4** Verify: `pnpm --filter @medina/db test` → 138/138 PASS (nada quebra)
- [ ] **2.5** Commit: `chore(db): align Drizzle businessHours default with metadata pattern (#14)`

### Task 3: Issue #18 — reindex-document clinic_id guard (small)

- [ ] **3.1** RED — em `apps/web/lib/inngest/functions/__tests__/reindex-document.test.ts` adicionar test "rejects with cross-tenant violation when event clinicId mismatches doc owner"
- [ ] **3.2** Run → FAIL
- [ ] **3.3** Modificar `apps/web/lib/inngest/functions/reindex-document.ts:35-54` — adicionar:
  ```ts
  const { data: doc } = await supabase
    .from('knowledge_documents')
    .select('clinic_id')
    .eq('id', documentId)
    .single()
  if (!doc) throw new Error(`document ${documentId} not found`)
  if (doc.clinic_id !== event.data.clinicId) {
    throw new Error(`cross-tenant violation: document ${documentId} belongs to ${doc.clinic_id}, not ${event.data.clinicId}`)
  }
  ```
- [ ] **3.4** Run → PASS
- [ ] **3.5** Commit: `fix(inngest): reindex-document validates clinic_id ownership (#18)`

### Task 4: Issue #17 — seed-kb atomic / zombie detection (small-medium)

- [ ] **4.1** RED — adicionar test em `packages/db/tests/rls/seed-kb.test.ts`: "re-run após falha no meio recupera (status=processing detectado)"
- [ ] **4.2** Run → FAIL
- [ ] **4.3** Modificar `packages/ai/src/seed-kb.ts` idempotency lookup: além de checar `content_hash`, checar `status` — se `status='processing'`, considerar não-completado e refazer (deletar chunks parciais + reset status)
- [ ] **4.4** Adicionar try/catch no loop de embeddings que, em falha, deixa documento em status='failed' (em vez de zombie 'processing')
- [ ] **4.5** Run → PASS (test simula failure no meio + re-run completa)
- [ ] **4.6** Commit: `fix(ai): seed-kb resilience — detect zombie status=processing on re-run (#17)`

### Task 5: Issue #12 — collect-info atomic RPC (medium)

- [ ] **5.1** Criar migration `packages/db/migrations/0023_collect_info_atomic.sql`:
  ```sql
  CREATE OR REPLACE FUNCTION public.collect_info_atomic(
    p_conversation_id uuid,
    p_clinic_id       uuid,
    p_field           text,
    p_value           text
  )
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_catalog, pg_temp AS $$
  DECLARE
    v_clinic uuid;
    v_metadata jsonb;
  BEGIN
    SELECT clinic_id, metadata
    INTO   v_clinic, v_metadata
    FROM   public.conversations
    WHERE  id = p_conversation_id AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation not found';
    END IF;
    IF v_clinic IS DISTINCT FROM p_clinic_id THEN
      RAISE EXCEPTION 'cross-tenant violation';
    END IF;

    UPDATE public.conversations
    SET    metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             ARRAY['collected_info', p_field],
             to_jsonb(p_value),
             true
           ),
           updated_at = NOW()
    WHERE  id = p_conversation_id;

    SELECT metadata INTO v_metadata FROM public.conversations WHERE id = p_conversation_id;
    RETURN v_metadata->'collected_info';
  END;
  $$;

  REVOKE EXECUTE ON FUNCTION public.collect_info_atomic(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
  GRANT  EXECUTE ON FUNCTION public.collect_info_atomic(uuid,uuid,text,text) TO service_role;
  ```
- [ ] **5.2** RED — `packages/db/tests/rls/collect-info-rpc.test.ts` 4 tests: atomic update, FOR UPDATE serializa concurrent calls (não perde field), cross-tenant exception, service_role only
- [ ] **5.3** Run → FAIL
- [ ] **5.4** Aplicar migration via Supabase MCP
- [ ] **5.5** Run → PASS
- [ ] **5.6** Modificar `packages/ai/src/tools/collect-info.ts:40-63` — substituir read-modify-write por `supabase.rpc('collect_info_atomic', { p_conversation_id, p_clinic_id, p_field, p_value })`
- [ ] **5.7** RED — extender `packages/ai/tests/tools/collect-info.test.ts` ou criar `collect-info.atomic.test.ts`: tool chama RPC com args corretos; tool retorna `{ ok, collected: <obj> }`
- [ ] **5.8** Run → PASS
- [ ] **5.9** Advisor security check
- [ ] **5.10** Commit: `feat(db): 0023 collect_info_atomic RPC + refactor tool (#12)`

### Task 6: iclinic typecheck fix (small-medium)

- [ ] **6.1** Diagnóstico — rodar `pnpm --filter @medina/integrations-pep-iclinic typecheck` e confirmar 3 categorias de erro:
  - TS17004 (JSX flag missing em table.tsx)
  - TS2307 (Cannot find module `@/lib/inngest/client`)
  - TS2339 (Headers.entries não existe — lib outdated)
- [ ] **6.2** Inspecionar `packages/integrations/pep/iclinic/tsconfig.json` — provavelmente está incluindo `apps/web/**` por extends ou include errado
- [ ] **6.3** Solução A (preferred): restringir `include` a `src/**/*` apenas — sem extender tsconfig que puxa apps/web
- [ ] **6.4** Solução B (fallback): adicionar `"jsx": "preserve"` + `"paths": { "@/*": ["../../../apps/web/*"] }` se realmente precisa fazer cross-package check
- [ ] **6.5** Verify `pnpm --filter @medina/integrations-pep-iclinic typecheck` → 0 erros
- [ ] **6.6** Verify outros packages não regrediram: full monorepo typecheck
- [ ] **6.7** Commit: `fix(build): iclinic tsconfig isolated from apps/web cross-package leak`

### Task 7: Verificação final + finishing

- [ ] **7.1** `pnpm test` em todos os packages → todos verdes
- [ ] **7.2** `pnpm typecheck` em todos os 12 packages → 0 erros (incluindo iclinic agora!)
- [ ] **7.3** `pnpm --filter @medina/web build` → SUCCESS
- [ ] **7.4** Advisor security via Supabase MCP → zero ERROR novos
- [ ] **7.5** Push branch + abrir PR-B (não merge)
- [ ] **7.6** Confirma que issues #12, #14, #17, #18, #19 fechadas no PR description (`Closes #12 #14 #17 #18 #19`)

---

## Critérios de aceite

- 6 issues fechadas (5 follow-ups + iclinic typecheck)
- 1 nova migration (0023) aplicada em prod via MCP
- Suite de testes total >= 444 + ~15 novos = ~459 verdes
- Typecheck 12 packages sem erros (incluindo iclinic)
- Sem regressão funcional em AI-1/2/3/4/5
- PR < 600 linhas

## Out of scope

- **Issue #21** (per-clinic kb threshold) — vai pra **PR-C** separado (~250 linhas, feature focada)
- **AI-3.5** (UI upload knowledge documents) — não é follow-up, é feature nova
- **AI-4** (Cal.com integration) — feature nova, escopo próprio
- **AI-6** (memory per-patient via mastra-memory) — feature nova
- Refatoração geral de Inngest workers (cobertura, retry config global)

## Riscos

| Risco | Mitigação |
|-------|-----------|
| Migration 0023 quebra collect-info em prod durante deploy | RPC nova é additive (3-arg overload). Tool refatorada chama RPC direto; sem behavior mudança fora do que testes validam. Aplicar via MCP em fase 1, então push branch (Vercel deploy puxa código novo simultâneamente). |
| iclinic fix muda tsconfig — risco de quebrar build em outras integrações pep | Aplicar fix isolado, full monorepo typecheck garante non-regression. |
| seed-kb zombie detection muda comportamento — risco de re-indexar documentos legítimos | Test cobre o caso "status=indexed → skip" continua funcionando. |
| Novos `medication_request` etc não são afetados (AI-5 isolado em packages/ai/src/guardrails/) | n/a |

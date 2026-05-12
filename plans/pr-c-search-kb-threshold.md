# PR-C — search_kb similarity threshold per-clinic (Issue #21)

> **Sub-skill:** `superpowers:executing-plans` (INLINE). Sub-tasks com checkboxes `- [ ]`.

**Goal:** Tornar o `SIMILARITY_THRESHOLD` da tool `search_kb` configurável por clínica via `agent_configs.kb_similarity_threshold`. Atual: hardcoded `0.4` em `packages/ai/src/tools/search-kb.ts:23`. Após PR-C: cada clínica pode tunar (e.g., 0.3 pra cobertura mais agressiva ou 0.6 pra precisão maior) via update SQL no agent_config.

**Architecture:** Coluna numeric(3,2) DEFAULT 0.4 com CHECK [0,1]. Drizzle schema + AgentConfig type + agent-factory rowToConfig + ToolContext.kbSimilarityThreshold + search-kb consome de ctx em vez de constante. Dispatcher ja propaga ToolContext — apenas estender o shape.

**Tech Stack:** Mesma — TypeScript estrito, Vitest, Postgres/Supabase, Mastra Agent, pgvector.

---

## Context

PR #22 (commit `d19b4e9`) baixou hardcoded threshold de 0.7 → 0.4 baseado em smoke prod com text-embedding-3-small + PT-BR. Mas esse valor é compromisso pra UMA clínica (sao-lucas). Outras clínicas podem ter:
- KB com terminologia diferente (técnica vs coloquial) — exige threshold diferente
- Volume de FAQ maior — pode permitir threshold mais alto sem perder cobertura
- Trade-off FP/FN próprio — clínica de estética pode tolerar mais FP que clínica oncológica

Issue #21 (CodeRabbit no PR de hotfix) recomenda capturar como follow-up. PR-B deliberadamente excluiu pra ficar focado em cleanup; PR-C entrega isolado.

---

## File Structure

**Create:**
- `packages/db/migrations/0025_agent_configs_kb_similarity_threshold.sql` — coluna + CHECK + default
- `packages/db/tests/rls/agent-configs-kb-threshold.test.ts` — schema/CHECK/default tests

**Modify:**
- `packages/db/src/schema/agent-configs.ts` — Drizzle field `kbSimilarityThreshold`
- `packages/ai/src/types.ts` — `AgentConfig.kbSimilarityThreshold: number`; `ToolContext.kbSimilarityThreshold: number`
- `packages/ai/src/agent-factory.ts` — `rowToConfig` parse PostgREST string→number (numeric column)
- `packages/ai/src/tools/search-kb.ts` — usar `ctx.kbSimilarityThreshold` em vez de constante; manter constante como `DEFAULT_THRESHOLD_FALLBACK = 0.4` pra back-compat se ctx omitir
- `packages/ai/src/dispatcher.ts` — passar `kbSimilarityThreshold: cfg.kbSimilarityThreshold` no `ToolContext`
- `packages/ai/tests/agent-factory.test.ts` — test parses numeric string
- `packages/ai/tests/tools/search-kb.test.ts` — test reads from ctx
- `packages/ai/tests/dispatcher.test.ts` — test passes threshold to ToolContext

**Won't change:**
- `packages/db/migrations/0001-0024` (forward-only)
- `packages/ai/src/rag.ts` (`retrieveKnowledge` já aceita `similarityThreshold` param — só estamos plumando)
- AI-5 guardrails (sem interação)
- AI-2 collect-info / AI-3 reindex (sem interação)

---

## Migration 0025 — SQL real

```sql
-- ════════════════════════════════════════════════════════════════════════════
-- 0025_agent_configs_kb_similarity_threshold.sql
--
-- Issue #21: torna SIMILARITY_THRESHOLD do search_kb tool configuravel
-- per-clinic. Atual: hardcoded 0.4 em packages/ai/src/tools/search-kb.ts.
-- Apos esta migration: agent_configs.kb_similarity_threshold (numeric 3,2)
-- DEFAULT 0.4 com CHECK [0, 1]. Existing rows ganham 0.4 via DEFAULT.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS kb_similarity_threshold NUMERIC(3, 2) NOT NULL DEFAULT 0.4;

ALTER TABLE public.agent_configs
  DROP CONSTRAINT IF EXISTS agent_configs_kb_similarity_threshold_valid;

ALTER TABLE public.agent_configs
  ADD CONSTRAINT agent_configs_kb_similarity_threshold_valid
  CHECK (kb_similarity_threshold >= 0.0 AND kb_similarity_threshold <= 1.0);

-- Backfill explicito (defensive — DEFAULT cobre INSERTs novos mas garantir
-- que rows existentes pre-migration tenham valor não-nulo).
UPDATE public.agent_configs
SET kb_similarity_threshold = 0.4
WHERE kb_similarity_threshold IS NULL;
```

**Schema-migration-checklist self-check:**
- ✅ Sem RPC nova → sem search_path / SECURITY DEFINER
- ✅ Sem RLS policy nova
- ✅ NOT NULL + DEFAULT garante coluna inicializada
- ✅ CHECK constraint pre-validation
- ✅ Backfill defensivo
- ✅ Numeric(3,2) precisão suficiente: 0.00–9.99 cobre 0.0–1.0

---

## Tasks

### Task 0: Worktree + branch

- [ ] **0.1** Criar `.worktrees/pr-c-kb-threshold`, branch `g/pr-c-kb-threshold` da main pós-PR-B
- [ ] **0.2** `pnpm install` + copiar `.env.local`
- [ ] **0.3** Baseline: ai 174, db 146, web 118, chat 32 = 470 verde

### Task 1: Migration 0025 (TDD)

- [ ] **1.1** RED — `packages/db/tests/rls/agent-configs-kb-threshold.test.ts` 4 tests:
  - coluna existe + default 0.4
  - CHECK rejeita < 0
  - CHECK rejeita > 1
  - aceita 0.0, 0.5, 1.0 (boundaries)
- [ ] **1.2** Run → FAIL (coluna não existe)
- [ ] **1.3** Implementar `0025_agent_configs_kb_similarity_threshold.sql`
- [ ] **1.4** Aplicar via Supabase MCP (`apply_migration`) no project `vgdbpwdewoahvyqyaziv`
- [ ] **1.5** Run → 4 PASS
- [ ] **1.6** Advisor security check zero new criticals
- [ ] **1.7** Commit: `feat(db): 0025 agent_configs.kb_similarity_threshold (#21)`

### Task 2: Drizzle schema + AgentConfig type

- [ ] **2.1** Adicionar em `packages/db/src/schema/agent-configs.ts`:
  ```ts
  kbSimilarityThreshold: numeric('kb_similarity_threshold', { precision: 3, scale: 2 })
    .notNull()
    .default('0.4'),
  ```
- [ ] **2.2** Adicionar CHECK constraint no array `(t) => [...]`:
  ```ts
  check(
    'agent_configs_kb_similarity_threshold_valid',
    sql`${t.kbSimilarityThreshold} >= 0.0 AND ${t.kbSimilarityThreshold} <= 1.0`,
  ),
  ```
- [ ] **2.3** Adicionar em `packages/ai/src/types.ts AgentConfig`:
  ```ts
  /** Per-clinic override of search_kb similarity threshold [0, 1].
   *  PostgREST returns NUMERIC as string → factory parses to number. */
  kbSimilarityThreshold: number
  ```
- [ ] **2.4** RED — extender `packages/ai/tests/agent-factory.test.ts`: "rowToConfig parses kb_similarity_threshold from PostgREST string ('0.40' → 0.4)"
- [ ] **2.5** Run → FAIL
- [ ] **2.6** Modificar `packages/ai/src/agent-factory.ts:rowToConfig`:
  ```ts
  kbSimilarityThreshold: parseFloat((row['kb_similarity_threshold'] as string | number | null)?.toString() ?? '0.4'),
  ```
  Ou helper dedicado pra parser numeric.
- [ ] **2.7** Run → PASS
- [ ] **2.8** Commit: `feat(ai): plumb kb_similarity_threshold from agent_config (#21)`

### Task 3: ToolContext + search-kb consume

- [ ] **3.1** Estender `packages/ai/src/types.ts ToolContext`:
  ```ts
  /** AI-3 follow-up #21: per-clinic threshold pra search_kb. */
  kbSimilarityThreshold?: number
  ```
- [ ] **3.2** RED — extender `packages/ai/tests/tools/search-kb.test.ts`: "uses ctx.kbSimilarityThreshold when provided"
- [ ] **3.3** Run → FAIL
- [ ] **3.4** Modificar `packages/ai/src/tools/search-kb.ts:23-47`:
  ```ts
  const DEFAULT_THRESHOLD_FALLBACK = 0.4 // back-compat se ctx omitir

  // Em execute:
  const threshold = ctx.kbSimilarityThreshold ?? DEFAULT_THRESHOLD_FALLBACK
  // ...
  const chunks = await retrieveKnowledge({
    ...,
    similarityThreshold: threshold,
  })
  // audit_logs.metadata.threshold = threshold (não mais constante)
  ```
- [ ] **3.5** Run → PASS
- [ ] **3.6** Commit: `feat(ai): search_kb consome ctx.kbSimilarityThreshold (#21)`

### Task 4: Dispatcher plumb

- [ ] **4.1** RED — extender `packages/ai/tests/dispatcher.test.ts`: "passes kb_similarity_threshold from cfg to ToolContext"
- [ ] **4.2** Run → FAIL
- [ ] **4.3** Modificar `packages/ai/src/dispatcher.ts`:
  - SELECT `agent_configs` inclui `kb_similarity_threshold`
  - `toolCtx: ToolContext = { clinicId, conversationId, supabase, knowledgeDocumentIds, kbSimilarityThreshold: cfg.kbSimilarityThreshold }`
- [ ] **4.4** Run → PASS
- [ ] **4.5** Commit: `feat(ai): dispatcher passa kb_similarity_threshold pra ToolContext (#21)`

### Task 5: Final verify + finishing

- [ ] **5.1** `pnpm test` em todos os 4 packages — esperar +6 testes (4 db + 1 factory + 1 search-kb + 1 dispatcher)
- [ ] **5.2** `pnpm -r typecheck` 12/12 zero
- [ ] **5.3** `pnpm --filter @medina/web build` SUCCESS
- [ ] **5.4** Advisor security zero ERROR novos
- [ ] **5.5** Push + abrir PR-C `feat(ai): per-clinic search_kb similarity threshold (#21)`
- [ ] **5.6** PR body: contexto Issue #21, justificativa do trade-off per-clinic, schema migration, plumbing completo, smoke pós-merge na sao-lucas (atualizar valor pra confirmar query result diferente)
- [ ] **5.7** Closes #21
- [ ] **5.8** **NÃO mergear** — aguarda CodeRabbit + tua aprovacao

---

## Critérios de aceite

- Migration 0025 aplicada em prod via MCP, advisor zero ERROR novo
- 4 testes db cobrindo schema/CHECK/default + boundaries
- AgentConfig type + Drizzle schema com kbSimilarityThreshold sincronizados com DB
- search-kb tool lê de ctx (não constante hardcoded), audit registra threshold real usado
- Dispatcher SELECT + toolCtx wiring testado
- Sao-lucas continua com 0.4 (default); outras clinicas podem mudar via SQL
- Suite total ≥ 476 verdes (470 + ~6 novos)
- `pnpm -r typecheck` 12/12 zero
- PR < 600 linhas

## Out of scope

- **UI admin pra editar threshold** — atualização via SQL direto em prod por ora; UI em PR futuro quando admin dashboard for priorizado
- **Validation runtime** (e.g., warning if threshold > 0.8 unusual) — só DB CHECK por enquanto
- **Auto-tuning baseado em feedback do paciente** (ML loop) — feature R&D
- **Per-document threshold** — overkill por agora, per-clinic já cobre 95% dos casos
- **Threshold negativo (cosine distance)** — pgvector retorna similarity já normalizada [0,1]; sem necessidade

## Riscos

| Risco | Mitigação |
|-------|-----------|
| Clínica configura 0.0 e search_kb retorna lixo (toda chunk passa) | CHECK [0,1] permite mas é decisão admin. Documentar em comentário SQL + futuro UI alertaria. |
| PostgREST serializa numeric(3,2) como string ('0.40') vs number | Factory parser explícito (parseFloat) — pattern já estabelecido pra `temperature`. Test cobre. |
| Migration durante deploy de PR-C — race condition entre dispatch antigo (sem threshold) e novo | Default DB cobre INSERT/SELECT no row velho; código antigo passa via dispatcher mas tool fallback usa DEFAULT_THRESHOLD_FALLBACK = 0.4 (mesmo valor). Comportamento idêntico durante deploy. |
| CHECK [0, 1] rejeita 1.000001 mas aceita 0.99 — precisão numeric(3,2) fica .999 | Aceitável: granularidade 0.01 é suficiente pra tuning manual. Se precisar mais, escalar pra numeric(5,4) em PR futuro. |

# Issue 12: Agent AI Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create versioned `agent_configs`, `knowledge_documents`, and `knowledge_chunks` (pgvector RAG) tables with RLS, triggers, and helper functions to back the Mastra AI agent system.

**Architecture:** Three tables with full multi-tenant isolation via `clinic_id` + RLS. `agent_configs` is immutable-versioned (draft → published → archived) with a single published per `(clinic, name)`. `knowledge_chunks` stores pgvector embeddings for RAG. Two SECURITY DEFINER helpers — `publish_agent_config` and `search_knowledge_chunks` — expose safe transactional operations.

**Tech Stack:** Postgres + pgvector + pg_trgm (all pre-enabled in 0000) · Drizzle ORM customType for `vector(1536)` · Vitest RLS integration tests · Supabase MCP for apply

---

## Schema-Migration-Checklist — Etapa 2 Risk Analysis

### RLS performance
- No raw `auth.uid()` in any policy expression. All policies call `is_clinic_member()` or `has_clinic_role()` (already SECURITY DEFINER helpers). The only place `auth.uid()` appears directly is `(SELECT auth.uid())` inside SECURITY DEFINER trigger/function bodies.

### Cross-tenant FKs with triggers
| FK | Trigger | When |
|---|---|---|
| `knowledge_chunks.document_id → knowledge_documents` | `validate_chunk_clinic_match` BEFORE INSERT | clinic_ids must match |
| `messages.agent_config_id → agent_configs` | `validate_message_agent_config_clinic` BEFORE INSERT | clinic_id match + status = 'published' |

### BEFORE vs AFTER decision
| Trigger | Timing | Reason |
|---|---|---|
| `set_updated_at` on agent_configs/knowledge_documents | BEFORE UPDATE | Modifies NEW.updated_at |
| `auto_set_agent_version` on agent_configs | BEFORE INSERT | Modifies NEW.version |
| `validate_chunk_clinic_match` on knowledge_chunks | BEFORE INSERT | Validates before write |
| `validate_message_agent_config_clinic` on messages | BEFORE INSERT | Validates before write |
| `audit_agent_config_change` on agent_configs | AFTER INSERT/UPDATE | Inserts to audit_logs |
| `audit_knowledge_document_change` on knowledge_documents | AFTER INSERT/UPDATE | Inserts to audit_logs |

### SECURITY DEFINER functions (all have explicit search_path)
- `auto_set_agent_version()` — queries agent_configs (which has RLS)
- `validate_chunk_clinic_match()` — queries knowledge_documents (which has RLS)
- `validate_message_agent_config_clinic()` — queries agent_configs (which has RLS)
- `audit_agent_config_change()` — inserts into audit_logs
- `audit_knowledge_document_change()` — inserts into audit_logs
- `publish_agent_config(uuid)` — multi-step transactional update
- `search_knowledge_chunks(...)` — queries knowledge_chunks (RLS + vector search)

### Audit user_id NULL
When triggered by service_role (indexing worker), `auth.uid()` returns NULL. `audit_logs.user_id` already allows NULL (FK with `ON DELETE SET NULL` pattern).

### Migration ordering (no forward references)
1. `agent_configs` table
2. `knowledge_documents` table
3. `knowledge_chunks` table (references knowledge_documents)
4. FK: `ALTER TABLE messages ADD CONSTRAINT ... REFERENCES agent_configs`
5. Trigger functions (reference tables above)
6. Triggers on tables
7. RLS + policies
8. Grants
9. `publish_agent_config` and `search_knowledge_chunks` helper functions (call is_clinic_member/has_clinic_role and reference all three tables)

---

## File Map

| File | Action |
|---|---|
| `plans/issue-12-agent-schema.md` | CREATE (this file) |
| `packages/db/tests/rls/agent.test.ts` | CREATE (TDD Red → Green) |
| `packages/db/tests/rls/helpers/setup.ts` | MODIFY (add agent helper functions) |
| `packages/db/migrations/0009_agent_ai.sql` | CREATE (migration) |
| `packages/db/src/schema/agent-configs.ts` | CREATE (Drizzle schema) |
| `packages/db/src/schema/knowledge-documents.ts` | CREATE (Drizzle schema) |
| `packages/db/src/schema/knowledge-chunks.ts` | CREATE (Drizzle schema) |
| `packages/db/src/schema/index.ts` | MODIFY (add exports) |

---

## Task 1: Write failing tests (TDD Red)

**Files:**
- Create: `packages/db/tests/rls/agent.test.ts`
- Modify: `packages/db/tests/rls/helpers/setup.ts`

- [ ] **Step 1.1: Add helper functions to setup.ts**

Add to `packages/db/tests/rls/helpers/setup.ts` (before `cleanupAll`):

```typescript
export async function createTestAgentConfig(
  sql: postgres.Sql,
  clinicId: string,
  opts: {
    name?: string;
    status?: string;
    systemPrompt?: string;
    model?: string;
  } = {},
): Promise<{ id: string; clinic_id: string; name: string; version: number; status: string }> {
  const name = opts.name ?? `agent-${Date.now()}`;
  const status = opts.status ?? 'draft';
  const systemPrompt = opts.systemPrompt ?? 'You are a helpful assistant.';
  const model = opts.model ?? 'claude-haiku-4-5';
  const rows = await sql<{ id: string; clinic_id: string; name: string; version: number; status: string }[]>`
    INSERT INTO agent_configs (clinic_id, name, status, system_prompt, model)
    VALUES (${clinicId}, ${name}, ${status}, ${systemPrompt}, ${model})
    RETURNING id, clinic_id, name, version, status
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestAgentConfig: no row returned');
  return row;
}

export async function createTestKnowledgeDocument(
  sql: postgres.Sql,
  clinicId: string,
  opts: { title?: string; sourceType?: string } = {},
): Promise<{ id: string; clinic_id: string }> {
  const title = opts.title ?? `Doc ${Date.now()}`;
  const sourceType = opts.sourceType ?? 'manual';
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO knowledge_documents (clinic_id, title, source_type)
    VALUES (${clinicId}, ${title}, ${sourceType})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestKnowledgeDocument: no row returned');
  return row;
}
```

Also update `cleanupAll` to include the new tables before `messages`:
```typescript
await sql`DELETE FROM knowledge_chunks`.catch(() => null);
await sql`DELETE FROM knowledge_documents`.catch(() => null);
await sql`DELETE FROM agent_configs`.catch(() => null);
```

- [ ] **Step 1.2: Write the full test file**

Create `packages/db/tests/rls/agent.test.ts` with all 10 test cases (see Task 2 for actual test code).

- [ ] **Step 1.3: Run tests to confirm RED**

```bash
cd packages/db && pnpm test -- agent.test.ts
```

Expected: All tests fail with "relation does not exist" or similar — confirms tests are valid.

---

## Task 2: Create migration 0009_agent_ai.sql

**Files:**
- Create: `packages/db/migrations/0009_agent_ai.sql`

- [ ] **Step 2.1: Write migration**

The migration contains in order:
1. `agent_configs` table + indexes
2. `knowledge_documents` table + indexes  
3. `knowledge_chunks` table + HNSW index
4. `ALTER TABLE messages ADD CONSTRAINT` for agent_config_id FK
5. Trigger functions (SECURITY DEFINER, explicit search_path)
6. Triggers on each table
7. RLS ENABLE + FORCE + policies
8. Grants + revokes
9. `publish_agent_config` helper
10. `search_knowledge_chunks` helper

- [ ] **Step 2.2: Apply via Supabase MCP**

Use `mcp__supabase-medina__apply_migration` with the SQL content.

---

## Task 3: Create Drizzle schemas

**Files:**
- Create: `packages/db/src/schema/agent-configs.ts`
- Create: `packages/db/src/schema/knowledge-documents.ts`
- Create: `packages/db/src/schema/knowledge-chunks.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 3.1: agent-configs.ts**

Types: `AgentStatus`, `AgentConfig`, `NewAgentConfig`. Uses `jsonb`, `text`, `uuid`, `numeric`, `integer`, `timestamp`, `pgTable`.

- [ ] **Step 3.2: knowledge-documents.ts**

Types: `DocumentStatus`, `SourceType`, `KnowledgeDocument`, `NewKnowledgeDocument`.

- [ ] **Step 3.3: knowledge-chunks.ts**

Uses `customType` for `vector(1536)`. Types: `KnowledgeChunk`, `NewKnowledgeChunk`.

- [ ] **Step 3.4: Update index.ts**

Add three new exports.

---

## Task 4: Run tests GREEN + validate

- [ ] **Step 4.1: Run full test suite**

```bash
cd packages/db && pnpm test -- agent.test.ts
```

Expected: All 10 tests pass.

- [ ] **Step 4.2: Validate advisors**

Use `mcp__supabase-medina__get_advisors` and confirm no new `auth_rls_initplan` warnings.

- [ ] **Step 4.3: Schema-migration-checklist Etapa 4 self-check (9 items)**

- [ ] Toda policy com auth.uid() usa `(select auth.uid())`? → Yes, no raw auth.uid() in policies
- [ ] FKs cross-tenant têm trigger de validação? → Yes: chunks.clinic_id + messages.agent_config_id
- [ ] Triggers BEFORE vs AFTER documentados? → Yes (see Etapa 2 above)
- [ ] Funções SECURITY DEFINER têm search_path explícito? → Yes, all `SET search_path = public, pg_catalog`
- [ ] Funções chamadas via supabase-js/postgres-js evitam SET parametrizado? → Yes, using `SELECT set_config(...)`
- [ ] Ordem de criação sem forward references? → Yes (see ordering above)
- [ ] Audit log preparado pra user_id NULL? → Yes, `(SELECT auth.uid())` can return NULL safely
- [ ] Plan tem SQL REAL? → Yes (migration file)
- [ ] Nomes de colunas em testes batem com schema existente? → Yes, verified from migrations

---

## Task 5: Commit

- [ ] **Step 5.1: Commit**

```bash
git add packages/db/migrations/0009_agent_ai.sql \
        packages/db/src/schema/agent-configs.ts \
        packages/db/src/schema/knowledge-documents.ts \
        packages/db/src/schema/knowledge-chunks.ts \
        packages/db/src/schema/index.ts \
        packages/db/tests/rls/agent.test.ts \
        packages/db/tests/rls/helpers/setup.ts \
        plans/issue-12-agent-schema.md
git commit -m "feat: issue 12 - agent ai schema with versioned configs and pgvector knowledge base"
```

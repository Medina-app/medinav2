# Pipeline Schema (Issue 10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add pipelines + pipeline_stages + deals tables with cross-tenant RLS, validation triggers, and Drizzle schemas.

**Architecture:** Three denormalized tables (clinic_id on all) for RLS performance. Triggers enforce cross-tenant FK integrity at all three levels. Audit log on deal stage moves.

**Tech Stack:** PostgreSQL, Drizzle ORM, Vitest, postgres.js, Supabase MCP

---

### Task 1: Write failing tests (RED)

**Files:**
- Create: `packages/db/tests/rls/pipeline.test.ts`
- Modify: `packages/db/tests/rls/helpers/setup.ts` (add helper functions)

- [ ] Add helpers to `setup.ts` after `createTestConversation`:

```ts
export async function createTestPipeline(
  sql: postgres.Sql,
  clinicId: string,
  opts: { name?: string; isDefault?: boolean } = {},
): Promise<{ id: string; clinic_id: string }> {
  const name = opts.name ?? `Pipeline ${Date.now()}`;
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO pipelines (clinic_id, name, is_default)
    VALUES (${clinicId}, ${name}, ${opts.isDefault ?? false})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestPipeline: no row returned');
  return row;
}

export async function createTestPipelineStage(
  sql: postgres.Sql,
  clinicId: string,
  pipelineId: string,
  opts: { name?: string; position?: number; stageType?: string } = {},
): Promise<{ id: string; clinic_id: string }> {
  const name = opts.name ?? `Stage ${Date.now()}`;
  const position = opts.position ?? 0;
  const stageType = opts.stageType ?? 'open';
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO pipeline_stages (clinic_id, pipeline_id, name, position, stage_type)
    VALUES (${clinicId}, ${pipelineId}, ${name}, ${position}, ${stageType})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestPipelineStage: no row returned');
  return row;
}

export async function createTestDeal(
  sql: postgres.Sql,
  clinicId: string,
  pipelineId: string,
  stageId: string,
  opts: { title?: string; position?: number } = {},
): Promise<{ id: string; clinic_id: string }> {
  const title = opts.title ?? `Deal ${Date.now()}`;
  const position = opts.position ?? 0;
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO deals (clinic_id, pipeline_id, stage_id, title, position)
    VALUES (${clinicId}, ${pipelineId}, ${stageId}, ${title}, ${position})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestDeal: no row returned');
  return row;
}
```

- [ ] Also update `cleanupAll` to include pipeline tables (before `audit_logs`):

```ts
await sql`DELETE FROM deals`.catch(() => null);
await sql`DELETE FROM pipeline_stages`.catch(() => null);
await sql`DELETE FROM pipelines`.catch(() => null);
```

- [ ] Create `packages/db/tests/rls/pipeline.test.ts` with all tests.

- [ ] Run `pnpm vitest run packages/db/tests/rls/pipeline.test.ts` — expect RED (tables don't exist yet).

### Task 2: Write migration

**Files:**
- Create: `packages/db/migrations/0007_pipeline.sql`

- [ ] Write the full migration (see ESCOPO in issue for column specs).

### Task 3: Write Drizzle schemas

**Files:**
- Create: `packages/db/src/schema/pipelines.ts`
- Create: `packages/db/src/schema/pipeline-stages.ts`
- Create: `packages/db/src/schema/deals.ts`
- Modify: `packages/db/src/schema/index.ts`

### Task 4: Apply migration via Supabase MCP

- [ ] Call `mcp__supabase-medina__apply_migration` with the SQL content.

### Task 5: Run tests — GREEN

- [ ] Run `pnpm vitest run packages/db/tests/rls/pipeline.test.ts`

### Task 6: Check advisors

- [ ] Call `mcp__supabase-medina__get_advisors` and verify no new critical warnings.

### Task 7: Commit

- [ ] `git add` all new/modified files and commit with message `feat: issue 10 - pipeline schema with kanban support and rls`

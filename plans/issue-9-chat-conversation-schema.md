# Issue 9 — Chat Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the `conversations` + `messages` tables with explicit state machine, cross-tenant FK guards, RLS, soft delete, and outbox-prep columns — the foundation for the livechat feature.

**Architecture:** `conversations` holds one-per-contact-per-integration session with an explicit state machine enforced by a SECURITY DEFINER function (not a trigger). `messages` are immutable append-only records with a denormalized `clinic_id` for RLS performance. Cross-tenant integrity is enforced by BEFORE triggers on both tables. Outbox columns are stubbed for future worker (not implemented here).

**Tech Stack:** Supabase Postgres · SQL migrations · Drizzle ORM (pgTable) · Vitest + postgres.js (RLS tests)

---

## Architectural Decisions

### State Machine
`transition_conversation_state(conv_id, new_state, reason)` is a `SECURITY DEFINER` function — not a trigger — so callers (AI worker, human agent) use it explicitly. It holds the allowed-transitions map statically and `RAISE EXCEPTION` on invalid moves. Every call inserts one `audit_log` row. **Why function, not trigger?** Triggers can't easily enforce directed-graph constraints; functions give clear error messages to callers.

### Soft Delete Strategy
`conversations.deleted_at` marks logical deletion. `SELECT` RLS policy filters `WHERE deleted_at IS NULL`. `messages` have no `deleted_at` — they're immutable and accessible by `clinic_id` even when the parent conversation is soft-deleted (intentional: message history must survive conversation archival). `cleanupAll` in test helpers must soft-delete conversations before hard-deleting, matching the pattern in `patients`.

### Outbox Prep
`messages.outbox_status` is `NULL` for inbound (no queue needed), `'pending'` for outbound messages awaiting the worker. The full outbox worker is a separate issue. Here we only add the column and the partial index for the worker query.

### Cross-Tenant FK Validation
- `conversations`: BEFORE INSERT/UPDATE trigger checks `patients.clinic_id = NEW.clinic_id` when `NEW.patient_id IS NOT NULL`. Trigger runs as table owner (bypasses patient RLS) so the lookup always works.
- `messages`: BEFORE INSERT trigger checks `conversations.clinic_id = NEW.clinic_id`. Same reasoning.

---

## Risk Points

| Risk | Mitigation |
|------|-----------|
| `transition_conversation_state` search_path injection | Add `SET search_path = public, pg_catalog` to function definition |
| Cross-tenant patient trigger needs to read `patients` across RLS | BEFORE trigger runs as table owner (not `authenticated`), bypassing RLS — explicitly tested |
| `CHECK (outbox_status IN (NULL, ...))` — NULL IN always NULL | Use `CHECK (outbox_status IS NULL OR outbox_status IN ('pending', ...))` |
| `cleanupAll` in setup.ts doesn't know about conversations yet | Update `cleanupAll` before writing tests |
| Drizzle `$type<>()` doesn't enforce at DB level | Checks defined in migration SQL are the authoritative constraint; Drizzle types are ergonomic only |

---

## Files

| Action | Path |
|--------|------|
| Modify | `packages/db/tests/rls/helpers/setup.ts` |
| Create | `packages/db/tests/rls/chat.test.ts` |
| Create | `packages/db/migrations/0005_chat.sql` |
| Create | `packages/db/src/schema/conversations.ts` |
| Create | `packages/db/src/schema/messages.ts` |
| Modify | `packages/db/src/schema/index.ts` |

---

## Task 1: Extend test helpers

**Files:** Modify `packages/db/tests/rls/helpers/setup.ts`

- [ ] Add `createTestConversation` after `createTestIntegration`:

```typescript
export async function createTestConversation(
  sql: postgres.Sql,
  clinicId: string,
  integrationId: string,
  opts: { externalId?: string; state?: string } = {},
): Promise<{ id: string; clinic_id: string }> {
  const externalId = opts.externalId ?? `+5511${Date.now().toString().slice(-9)}`;
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO conversations (clinic_id, integration_id, channel, external_id)
    VALUES (${clinicId}, ${integrationId}, 'whatsapp', ${externalId})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestConversation: no row returned');
  return row;
}
```

- [ ] Add `createTestMessage` after `createTestConversation`:

```typescript
export async function createTestMessage(
  sql: postgres.Sql,
  conversationId: string,
  clinicId: string,
  opts: { content?: string; direction?: string } = {},
): Promise<{ id: string }> {
  const content = opts.content ?? `msg-${Date.now()}`;
  const direction = opts.direction ?? 'inbound';
  const senderType = direction === 'inbound' ? 'patient' : 'ai';
  const rows = await sql<{ id: string }[]>`
    INSERT INTO messages (conversation_id, clinic_id, direction, sender_type, content_type, content)
    VALUES (${conversationId}, ${clinicId}, ${direction}, ${senderType}, 'text', ${content})
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestMessage: no row returned');
  return row;
}
```

- [ ] Prepend to `cleanupAll` (before existing `patients` cleanup):

```typescript
// conversations + messages
await sql`UPDATE conversations SET deleted_at = NOW() WHERE deleted_at IS NULL`;
await sql`DELETE FROM messages`;
await sql`DELETE FROM conversations`;
```

---

## Task 2: Write failing tests (RED)

**Files:** Create `packages/db/tests/rls/chat.test.ts`

- [ ] Create the file with all 8 tests:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic, cleanupAll, createTestClinic, createTestConversation,
  createTestIntegration, createTestMessage, createTestPatient,
  createTestUser, getRlsClient, getServiceClient,
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

    await sql`SELECT transition_conversation_state(${conv.id}, 'waiting_human', 'handoff')`;
    const [updated] = await sql<{ state: string }[]>`
      SELECT state FROM conversations WHERE id = ${conv.id}
    `;
    expect(updated?.state).toBe('waiting_human');

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

    await sql`UPDATE conversations SET deleted_at = NOW() WHERE id = ${conv.id}`;

    const convRows = await getRlsClient(sql, user.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM conversations WHERE id = ${conv.id}`,
    );
    expect(convRows).toHaveLength(0);

    const msgRows = await getRlsClient(sql, user.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM messages WHERE id = ${msg.id}`,
    );
    expect(msgRows.map((r) => r.id)).toEqual([msg.id]);
  });
});

describe('audit log', () => {
  it('state changes are audit-logged automatically', async () => {
    const clinic = await createTestClinic(sql, 'Audit State');
    const integration = await createTestIntegration(sql, clinic.id);
    const conv = await createTestConversation(sql, clinic.id, integration.id);

    await sql`SELECT transition_conversation_state(${conv.id}, 'waiting_human', 'manual-handoff')`;

    const logs = await sql<{ table_name: string; old_data: Record<string, unknown>; new_data: Record<string, unknown> }[]>`
      SELECT table_name, old_data, new_data
      FROM audit_logs
      WHERE record_id = ${conv.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(logs[0]?.table_name).toBe('conversations');
    expect(logs[0]?.new_data?.['state']).toBe('waiting_human');
    expect(logs[0]?.old_data?.['state']).toBe('ai_handling');
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
```

- [ ] Run `pnpm --filter @medina/db test` — expect all tests to FAIL with "relation does not exist"

---

## Task 3: Write migration SQL

**Files:** Create `packages/db/migrations/0005_chat.sql`

Structure (write each section in order — no partial skips):

- [ ] **Section 1 — `transition_conversation_state` function**
  - `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog`
  - Declare `allowed_transitions` as a local lookup (nested CASE or array of records)
  - Validate `new_state` is in allowed set for `current state`; RAISE EXCEPTION with message `'Invalid state transition from X to Y'` on failure
  - UPDATE `conversations SET state = new_state, updated_at = NOW() WHERE id = conv_id`
  - INSERT into `audit_logs (table_name, record_id, action, old_data, new_data, changed_by)` — `old_data` = `jsonb_build_object('state', old_state)`, same for new, `changed_by = auth.uid()`
  - GRANT EXECUTE to `authenticated`

- [ ] **Section 2 — `conversations` table** with all columns from spec
  - Inline CHECK constraints: `channel`, `state` (7 values), valid UUIDs are FK-enforced
  - `outbox_status`: `CHECK (outbox_status IS NULL OR outbox_status IN ('pending','processing','sent','failed'))` — note: `NULL IN (...)` is always NULL in SQL so use IS NULL explicitly
  - All indexes from spec (6 total, most with WHERE clauses)

- [ ] **Section 3 — `messages` table** with all columns from spec
  - `delivery_status` check, `outbox_status` same NULL-safe check pattern
  - Indexes: 4 total

- [ ] **Section 4 — Triggers** (in dependency order)
  - `conversations_set_updated_at` — BEFORE UPDATE, standard pattern
  - `conversations_validate_patient_clinic` — BEFORE INSERT OR UPDATE, checks `patients.clinic_id = NEW.clinic_id` when `NEW.patient_id IS NOT NULL`, RAISE EXCEPTION on mismatch
  - `conversations_audit_state_changes` — AFTER UPDATE, fires WHEN `OLD.state <> NEW.state OR OLD.assigned_user_id IS DISTINCT FROM NEW.assigned_user_id OR OLD.ai_enabled <> NEW.ai_enabled`; inserts audit_log
  - `messages_validate_clinic_match` — BEFORE INSERT, checks `conversations.clinic_id = NEW.clinic_id`, RAISE EXCEPTION on mismatch
  - `messages_update_conversation` — AFTER INSERT, updates `last_message_at`, `last_message_preview`, `last_inbound_at`/`last_outbound_at`, and increments/resets `unread_count`

- [ ] **Section 5 — RLS + policies**
  - `ALTER TABLE conversations ENABLE ROW LEVEL SECURITY`
  - `ALTER TABLE messages ENABLE ROW LEVEL SECURITY`
  - 4 policies on `conversations` (SELECT filters `deleted_at IS NULL`, UPDATE uses assigned_or_admin)
  - 3 policies on `messages` (SELECT + INSERT; no UPDATE/DELETE for `authenticated`)
  - `GRANT SELECT, INSERT, UPDATE, DELETE ON conversations TO authenticated`
  - `GRANT SELECT, INSERT ON messages TO authenticated`
  - `REVOKE UPDATE, DELETE ON messages FROM authenticated`

---

## Task 4: Apply migration

- [ ] Use Supabase MCP `apply_migration` with name `0005_chat` and the full SQL from Task 3
- [ ] If migration errors: read the error message, fix the specific SQL section, re-apply

---

## Task 5: Write Drizzle schemas

**Files:** Create `packages/db/src/schema/conversations.ts` and `messages.ts`

- [ ] `conversations.ts` — key patterns to follow:
  - Import `pgTable, uuid, text, boolean, integer, timestamp, jsonb, index, uniqueIndex, check` from `drizzle-orm/pg-core`
  - Use `text('state').$type<ConversationState>()` for typed columns
  - Export `ConversationState`, `MessageDirection`, `SenderType`, `ContentType`, `DeliveryStatus`, `OutboxStatus` as union types
  - Export `Conversation`, `NewConversation` via `$inferSelect` / `$inferInsert`
  - `tags` column: `.array().notNull().default(sql\`'{}'\`)`
  - Indexes: use `.where(sql\`${t.deletedAt} IS NULL\`)` pattern from `patients.ts`

- [ ] `messages.ts` — same pattern; `in_reply_to` self-references `messages.id`:
  ```typescript
  inReplyTo: uuid('in_reply_to').references((): AnyPgColumn => messages.id, { onDelete: 'set null' })
  ```
  (Import `AnyPgColumn` from `drizzle-orm/pg-core` for self-reference)

---

## Task 6: Update exports

**Files:** Modify `packages/db/src/schema/index.ts`

- [ ] Add two exports:
  ```typescript
  export * from './conversations.js';
  export * from './messages.js';
  ```

---

## Task 7: Run tests and validate

- [ ] Run `pnpm --filter @medina/db test` — all 8 tests must be GREEN
- [ ] If a test fails: read the error, check trigger logic or RLS policy, fix in a follow-up migration or fix the test expectation if the test was wrong
- [ ] Run `pnpm --filter @medina/db typecheck` — zero TypeScript errors
- [ ] Call Supabase MCP `get_advisors` — review security and performance warnings; fix any critical ones

---

## Task 8: Commit

- [ ] Stage files:
  ```
  packages/db/tests/rls/helpers/setup.ts
  packages/db/tests/rls/chat.test.ts
  packages/db/migrations/0005_chat.sql
  packages/db/src/schema/conversations.ts
  packages/db/src/schema/messages.ts
  packages/db/src/schema/index.ts
  ```
- [ ] Commit:
  ```
  feat: issue 9 - chat schema with conversation state machine and rls
  ```

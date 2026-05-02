# Issue 2 — Core Multi-Tenant Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap `packages/db` with Drizzle ORM and implement the core multi-tenant schema (clinics, clinic_members, audit_logs) with RLS isolation, validated by tests written before the tables exist.

**Architecture:** SQL-first — migrations are hand-written `.sql` files applied via `src/migrate.ts` (postgres-js + DATABASE_URL). Drizzle ORM provides TypeScript types and query building only; it does NOT generate or run migrations. Tests impersonate users inside postgres transactions using `SET LOCAL role = 'authenticated'` + `set_config('request.jwt.claims', ...)` to trigger RLS evaluation. All helper functions are `SECURITY DEFINER` to prevent recursion between `clinics` and `clinic_members` policies.

**Tech Stack:** drizzle-orm, postgres (postgres-js), dotenv, vitest, tsx · Supabase Postgres 17 · pnpm workspaces + Turborepo

> ⚠️ **RLS test requirement:** `DATABASE_URL` must use port **5432** (direct connection or session pooler). Port 6543 (transaction pooler) does not support `SET LOCAL` across queries and will break RLS tests. Check your `.env.local` before Task 10.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `packages/db/package.json` | Create | Workspace package, scripts, deps |
| `packages/db/tsconfig.json` | Create | TS config, overrides moduleResolution to node16 |
| `packages/db/vitest.config.ts` | Create | Sequential test execution, 30s timeout |
| `packages/db/drizzle.config.ts` | Create | Drizzle Kit introspection config |
| `packages/db/src/client.ts` | Create | postgres-js connection factory |
| `packages/db/src/schema/clinics.ts` | Create | Drizzle clinics table + types |
| `packages/db/src/schema/clinic-members.ts` | Create | Drizzle clinic_members table + types |
| `packages/db/src/schema/audit-logs.ts` | Create | Drizzle audit_logs table + types |
| `packages/db/src/schema/index.ts` | Create | Re-exports all schemas |
| `packages/db/src/index.ts` | Create | Public package exports |
| `packages/db/src/migrate.ts` | Create | Migration runner (reads `migrations/*.sql`, applies in order) |
| `packages/db/migrations/0000_core_schema.sql` | Create | Extensions, helpers, tables, RLS, policies, triggers |
| `packages/db/migrations/0001_hardening.sql` | Create | Revoke public schema access from anon |
| `packages/db/tests/rls/helpers/setup.ts` | Create | createTestClinic, createTestUser, addUserToClinic, getRlsClient, cleanupAll |
| `packages/db/tests/rls/clinics.test.ts` | Create | Tenant isolation, soft delete, role-based update |
| `packages/db/tests/rls/clinic-members.test.ts` | Create | Cross-tenant isolation, role permissions, enforce owner |
| `packages/db/tests/rls/audit-logs.test.ts` | Create | Non-admin blocked, admin allowed, tenant isolation |
| `turbo.json` | Modify | Add `cache: false` to test task (DB tests are non-deterministic) |

---

## Task 1: Bootstrap packages/db

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/vitest.config.ts`
- Create: `packages/db/drizzle.config.ts`

- [ ] **Step 1: Create directory structure**

Run:
```powershell
New-Item -ItemType Directory -Force packages/db/src/schema
New-Item -ItemType Directory -Force packages/db/migrations
New-Item -ItemType Directory -Force packages/db/tests/rls/helpers
```

- [ ] **Step 2: Create packages/db/package.json**

```json
{
  "name": "@medina/db",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "migrate": "tsx src/migrate.ts"
  },
  "dependencies": {
    "drizzle-orm": "^0.41.0",
    "postgres": "^3.4.5",
    "dotenv": "^16.4.7"
  },
  "devDependencies": {
    "@types/node": "^22",
    "drizzle-kit": "^0.30.0",
    "tsx": "^4.19.3",
    "typescript": "^5",
    "vitest": "^3.1.3"
  }
}
```

- [ ] **Step 3: Create packages/db/tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "moduleResolution": "node16",
    "module": "node16",
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "*.ts"]
}
```

> `node16` is used instead of `bundler` because this package runs in Node.js directly (tsx, vitest), not through a bundler. `bundler` resolution does not work with `tsx`.

- [ ] **Step 4: Install dependencies**

Run: `pnpm --filter @medina/db install`
Expected: Dependencies installed, pnpm-lock.yaml updated, no errors.

- [ ] **Step 5: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    sequence: {
      concurrent: false,
    },
    testTimeout: 30000,
  },
});
```

> `singleFork + sequence.concurrent = false` runs test files one at a time, preventing concurrent DB mutations from interfering with each other.

- [ ] **Step 6: Create drizzle.config.ts**

```typescript
import type { Config } from 'drizzle-kit';
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../apps/web/.env.local') });

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL']!,
  },
} satisfies Config;
```

- [ ] **Step 7: Update turbo.json — disable test caching**

Modify `turbo.json`, update the `test` task:

```json
"test": {
  "dependsOn": ["^build"],
  "cache": false
}
```

> DB integration tests are non-deterministic; caching their result would mask real failures.

---

## Task 2: Write RLS Test Helpers

**Files:**
- Create: `packages/db/tests/rls/helpers/setup.ts`

- [ ] **Step 1: Create setup.ts**

```typescript
import postgres from 'postgres';
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../../../apps/web/.env.local') });

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL not set in apps/web/.env.local');

export function getServiceClient(): postgres.Sql {
  return postgres(DATABASE_URL!, { max: 3 });
}

export async function createTestClinic(
  sql: postgres.Sql,
  name: string,
): Promise<{ id: string; name: string; slug: string }> {
  const slug = `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
  const rows = await sql<{ id: string; name: string; slug: string }[]>`
    INSERT INTO clinics (name, slug)
    VALUES (${name}, ${slug})
    RETURNING id, name, slug
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestClinic: no row returned');
  return row;
}

export async function createTestUser(
  sql: postgres.Sql,
): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  const email = `test-${id}@medina-test.internal`;
  await sql`
    INSERT INTO auth.users (
      id, instance_id, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      aud, role, raw_app_meta_data, raw_user_meta_data, is_super_admin
    ) VALUES (
      ${id},
      '00000000-0000-0000-0000-000000000000',
      ${email},
      '',
      NOW(), NOW(), NOW(),
      'authenticated', 'authenticated',
      '{"provider":"email","providers":["email"]}',
      '{}',
      false
    )
  `;
  return { id, email };
}

export async function addUserToClinic(
  sql: postgres.Sql,
  clinicId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member' = 'member',
): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO clinic_members (clinic_id, user_id, role)
    VALUES (${clinicId}, ${userId}, ${role})
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('addUserToClinic: no row returned');
  return row;
}

/**
 * Returns a client that executes queries as the given user,
 * with RLS enforced. Uses SET LOCAL inside a transaction so
 * the role and JWT claims are scoped to that transaction only.
 */
export function getRlsClient(
  sql: postgres.Sql,
  userId: string,
): {
  query: <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => Promise<T>;
} {
  return {
    query: <T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
      sql.begin(async (tx) => {
        await tx`SET LOCAL role = 'authenticated'`;
        await tx`
          SELECT set_config(
            'request.jwt.claims',
            ${JSON.stringify({ sub: userId, role: 'authenticated' })},
            TRUE
          )
        `;
        return fn(tx);
      }),
  };
}

export async function cleanupAll(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM audit_logs`;
  await sql`DELETE FROM clinic_members`;
  await sql`DELETE FROM clinics`;
  await sql`DELETE FROM auth.users WHERE email LIKE '%@medina-test.internal'`;
}
```

---

## Task 3: Write clinics.test.ts — RED Phase

**Files:**
- Create: `packages/db/tests/rls/clinics.test.ts`

- [ ] **Step 1: Create clinics.test.ts**

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic,
  cleanupAll,
  createTestClinic,
  createTestUser,
  getRlsClient,
  getServiceClient,
} from './helpers/setup.js';

const sql = getServiceClient();

beforeAll(async () => {
  await cleanupAll(sql);
});

afterAll(async () => {
  await cleanupAll(sql);
  await sql.end();
});

describe('clinics: tenant isolation', () => {
  it('member of clinic A cannot see clinic B', async () => {
    const clinicA = await createTestClinic(sql, 'Isolation A');
    const clinicB = await createTestClinic(sql, 'Isolation B');
    const user = await createTestUser(sql);
    await addUserToClinic(sql, clinicA.id, user.id, 'member');

    const client = getRlsClient(sql, user.id);
    const rows = await client.query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM clinics WHERE deleted_at IS NULL`,
    );

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(clinicA.id);
    expect(ids).not.toContain(clinicB.id);
  });
});

describe('clinics: soft delete', () => {
  it('soft-deleted clinic is invisible to its own members', async () => {
    const clinic = await createTestClinic(sql, 'SoftDelete Test');
    const user = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, user.id, 'member');

    await sql`UPDATE clinics SET deleted_at = NOW() WHERE id = ${clinic.id}`;

    const client = getRlsClient(sql, user.id);
    const rows = await client.query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM clinics WHERE deleted_at IS NULL`,
    );

    expect(rows.map((r) => r.id)).not.toContain(clinic.id);
  });
});

describe('clinics: role-based update', () => {
  it('owner can update clinic name', async () => {
    const clinic = await createTestClinic(sql, 'Update Owner');
    const owner = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, owner.id, 'owner');

    const client = getRlsClient(sql, owner.id);
    await expect(
      client.query((tx) =>
        tx`UPDATE clinics SET name = 'Updated' WHERE id = ${clinic.id}`,
      ),
    ).resolves.not.toThrow();
  });

  it('member cannot update clinic name (RLS silently blocks — 0 rows)', async () => {
    const clinic = await createTestClinic(sql, 'Update Member');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    const client = getRlsClient(sql, member.id);
    const result = await client.query((tx) =>
      tx<{ id: string }[]>`
        UPDATE clinics SET name = 'Hacked' WHERE id = ${clinic.id} RETURNING id
      `,
    );
    expect(result).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests — verify RED**

Run: `pnpm --filter @medina/db test`
Expected: Tests FAIL with `relation "clinics" does not exist` (or similar). This confirms the tests are live.

---

## Task 4: Write clinic-members.test.ts — RED Phase

**Files:**
- Create: `packages/db/tests/rls/clinic-members.test.ts`

- [ ] **Step 1: Create clinic-members.test.ts**

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic,
  cleanupAll,
  createTestClinic,
  createTestUser,
  getRlsClient,
  getServiceClient,
} from './helpers/setup.js';

const sql = getServiceClient();

beforeAll(async () => {
  await cleanupAll(sql);
});

afterAll(async () => {
  await cleanupAll(sql);
  await sql.end();
});

describe('clinic_members: cross-tenant isolation', () => {
  it('user of clinic A cannot see members of clinic B', async () => {
    const clinicA = await createTestClinic(sql, 'Members A');
    const clinicB = await createTestClinic(sql, 'Members B');
    const userA = await createTestUser(sql);
    const userB = await createTestUser(sql);
    await addUserToClinic(sql, clinicA.id, userA.id, 'member');
    await addUserToClinic(sql, clinicB.id, userB.id, 'member');

    const client = getRlsClient(sql, userA.id);
    const rows = await client.query((tx) =>
      tx<{ user_id: string }[]>`
        SELECT user_id FROM clinic_members WHERE deleted_at IS NULL
      `,
    );

    const userIds = rows.map((r) => r.user_id);
    expect(userIds).toContain(userA.id);
    expect(userIds).not.toContain(userB.id);
  });
});

describe('clinic_members: role permissions', () => {
  it('owner can add a new member', async () => {
    const clinic = await createTestClinic(sql, 'Role Add');
    const owner = await createTestUser(sql);
    const newUser = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, owner.id, 'owner');

    const client = getRlsClient(sql, owner.id);
    await expect(
      client.query((tx) =>
        tx`
          INSERT INTO clinic_members (clinic_id, user_id, role)
          VALUES (${clinic.id}, ${newUser.id}, 'member')
        `,
      ),
    ).resolves.not.toThrow();
  });

  it('plain member cannot add another member', async () => {
    const clinic = await createTestClinic(sql, 'Role Block');
    const member = await createTestUser(sql);
    const stranger = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    const client = getRlsClient(sql, member.id);
    await expect(
      client.query((tx) =>
        tx`
          INSERT INTO clinic_members (clinic_id, user_id, role)
          VALUES (${clinic.id}, ${stranger.id}, 'member')
        `,
      ),
    ).rejects.toThrow();
  });

  it('enforce_at_least_one_owner blocks soft-deleting the last owner', async () => {
    const clinic = await createTestClinic(sql, 'Last Owner');
    const owner = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, owner.id, 'owner');

    await expect(
      sql`
        UPDATE clinic_members
        SET deleted_at = NOW()
        WHERE clinic_id = ${clinic.id} AND user_id = ${owner.id}
      `,
    ).rejects.toThrow('clinic must have at least one owner');
  });
});
```

- [ ] **Step 2: Run tests — verify RED**

Run: `pnpm --filter @medina/db test`
Expected: FAIL — `relation "clinics" does not exist`.

---

## Task 5: Write audit-logs.test.ts — RED Phase

**Files:**
- Create: `packages/db/tests/rls/audit-logs.test.ts`

- [ ] **Step 1: Create audit-logs.test.ts**

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic,
  cleanupAll,
  createTestClinic,
  createTestUser,
  getRlsClient,
  getServiceClient,
} from './helpers/setup.js';

const sql = getServiceClient();

beforeAll(async () => {
  await cleanupAll(sql);
});

afterAll(async () => {
  await cleanupAll(sql);
  await sql.end();
});

async function seedAuditLog(
  clinicId: string,
  userId: string,
): Promise<void> {
  await sql`
    INSERT INTO audit_logs (clinic_id, user_id, action, resource)
    VALUES (${clinicId}, ${userId}, 'test_action', 'test_resource')
  `;
}

describe('audit_logs: non-admin cannot read', () => {
  it('plain member sees 0 audit log rows', async () => {
    const clinic = await createTestClinic(sql, 'Audit Member');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    await seedAuditLog(clinic.id, member.id);

    const client = getRlsClient(sql, member.id);
    const rows = await client.query((tx) =>
      tx<{ id: string }[]>`
        SELECT id FROM audit_logs WHERE clinic_id = ${clinic.id}
      `,
    );
    expect(rows).toHaveLength(0);
  });

  it('admin can read audit logs', async () => {
    const clinic = await createTestClinic(sql, 'Audit Admin');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');
    await seedAuditLog(clinic.id, admin.id);

    const client = getRlsClient(sql, admin.id);
    const rows = await client.query((tx) =>
      tx<{ id: string }[]>`
        SELECT id FROM audit_logs WHERE clinic_id = ${clinic.id}
      `,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('audit_logs: tenant isolation', () => {
  it('admin of clinic A cannot see audit logs of clinic B', async () => {
    const clinicA = await createTestClinic(sql, 'Audit Isolation A');
    const clinicB = await createTestClinic(sql, 'Audit Isolation B');
    const adminA = await createTestUser(sql);
    const userB = await createTestUser(sql);
    await addUserToClinic(sql, clinicA.id, adminA.id, 'admin');
    await addUserToClinic(sql, clinicB.id, userB.id, 'member');
    await seedAuditLog(clinicA.id, adminA.id);
    await seedAuditLog(clinicB.id, userB.id);

    const client = getRlsClient(sql, adminA.id);
    const rows = await client.query((tx) =>
      tx<{ clinic_id: string }[]>`SELECT clinic_id FROM audit_logs`,
    );

    expect(rows.every((r) => r.clinic_id === clinicA.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run ALL tests — confirm RED**

Run: `pnpm --filter @medina/db test`
Expected: ALL tests FAIL — `relation "clinics" does not exist`. Red phase confirmed.

---

## Task 6: Create 0000_core_schema.sql

**Files:**
- Create: `packages/db/migrations/0000_core_schema.sql`

- [ ] **Step 1: Create migration file**

```sql
-- ─── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Helper: auto-update updated_at ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ─── Helper: read clinic id from session config ───────────────────────────────
CREATE OR REPLACE FUNCTION current_clinic_id()
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_clinic_id', TRUE), '')::UUID;
$$;

-- ─── Helper: set clinic id in session config ──────────────────────────────────
CREATE OR REPLACE FUNCTION set_current_clinic(p_clinic_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.current_clinic_id', p_clinic_id::TEXT, TRUE);
END;
$$;

-- ─── Table: clinics ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinics (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  slug          TEXT        NOT NULL UNIQUE,
  plan          TEXT        NOT NULL DEFAULT 'trial'
                            CHECK (plan IN ('trial', 'starter', 'pro', 'enterprise')),
  trial_ends_at TIMESTAMPTZ,
  metadata      JSONB       NOT NULL DEFAULT '{}',
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_clinics_updated_at
  BEFORE UPDATE ON clinics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinics FORCE ROW LEVEL SECURITY;

-- ─── Table: clinic_members ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinic_members (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id  UUID        NOT NULL REFERENCES clinics(id),
  user_id    UUID        NOT NULL REFERENCES auth.users(id),
  role       TEXT        NOT NULL DEFAULT 'member'
                         CHECK (role IN ('owner', 'admin', 'member')),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, user_id)
);

CREATE TRIGGER trg_clinic_members_updated_at
  BEFORE UPDATE ON clinic_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE clinic_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_members FORCE ROW LEVEL SECURITY;

-- ─── RLS helpers (SECURITY DEFINER prevents RLS recursion) ───────────────────
-- These functions query clinic_members WITHOUT triggering its RLS policies,
-- which is required because clinics + clinic_members policies call each other.

CREATE OR REPLACE FUNCTION is_clinic_member(
  p_clinic_id UUID,
  p_user_id   UUID DEFAULT auth.uid()
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM clinic_members
    WHERE clinic_id   = p_clinic_id
      AND user_id     = p_user_id
      AND deleted_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION has_clinic_role(
  p_clinic_id UUID,
  p_role      TEXT,
  p_user_id   UUID DEFAULT auth.uid()
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM clinic_members
    WHERE clinic_id   = p_clinic_id
      AND user_id     = p_user_id
      AND role        = p_role
      AND deleted_at IS NULL
  );
$$;

-- ─── Trigger: enforce at least one owner per clinic ───────────────────────────
CREATE OR REPLACE FUNCTION enforce_at_least_one_owner()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Fires when: soft-deleting an owner OR downgrading an owner's role
  IF (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
     OR (NEW.role != 'owner' AND OLD.role = 'owner')
  THEN
    IF NOT EXISTS (
      SELECT 1 FROM clinic_members
      WHERE clinic_id   = NEW.clinic_id
        AND role        = 'owner'
        AND deleted_at IS NULL
        AND id         != NEW.id
    ) THEN
      RAISE EXCEPTION 'clinic must have at least one owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clinic_members_enforce_owner
  BEFORE UPDATE ON clinic_members
  FOR EACH ROW EXECUTE FUNCTION enforce_at_least_one_owner();

-- ─── Table: audit_logs ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID        NOT NULL REFERENCES clinics(id),
  user_id     UUID        REFERENCES auth.users(id),
  action      TEXT        NOT NULL,
  resource    TEXT        NOT NULL,
  resource_id UUID,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

-- ─── RLS Policies: clinics ────────────────────────────────────────────────────

CREATE POLICY "clinics: members can select"
  ON clinics FOR SELECT
  USING (is_clinic_member(id) AND deleted_at IS NULL);

CREATE POLICY "clinics: owners can update"
  ON clinics FOR UPDATE
  USING (has_clinic_role(id, 'owner'));

-- ─── RLS Policies: clinic_members ────────────────────────────────────────────

CREATE POLICY "clinic_members: members can select own clinic"
  ON clinic_members FOR SELECT
  USING (is_clinic_member(clinic_id));

CREATE POLICY "clinic_members: owners and admins can insert"
  ON clinic_members FOR INSERT
  WITH CHECK (
    has_clinic_role(clinic_id, 'owner')
    OR has_clinic_role(clinic_id, 'admin')
  );

CREATE POLICY "clinic_members: owners and admins can update"
  ON clinic_members FOR UPDATE
  USING (
    has_clinic_role(clinic_id, 'owner')
    OR has_clinic_role(clinic_id, 'admin')
  );

-- ─── RLS Policies: audit_logs ────────────────────────────────────────────────

CREATE POLICY "audit_logs: owners and admins can select"
  ON audit_logs FOR SELECT
  USING (
    has_clinic_role(clinic_id, 'owner')
    OR has_clinic_role(clinic_id, 'admin')
  );

-- Insert is service-role-only (application layer writes audit logs)
-- The service role bypasses RLS by default in Supabase.
```

---

## Task 7: Create 0001_hardening.sql

**Files:**
- Create: `packages/db/migrations/0001_hardening.sql`

- [ ] **Step 1: Create hardening migration**

```sql
-- Revoke CREATE privilege from PUBLIC on the public schema.
-- This prevents any role from creating objects unless explicitly granted.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Remove all table access from the anon role.
-- In Supabase, anon = unauthenticated requests. RLS policies control access;
-- these REVOKEs ensure no table-level fallback exists.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Remove implicit table grants from the authenticated role.
-- RLS policies are the sole access mechanism; no table-level grants as fallback.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;

-- Re-grant DML to authenticated so RLS policies can take effect.
-- Without this, even passing RLS checks would result in a permission error.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
```

---

## Task 8: Create Drizzle Schemas

**Files:**
- Create: `packages/db/src/schema/clinics.ts`
- Create: `packages/db/src/schema/clinic-members.ts`
- Create: `packages/db/src/schema/audit-logs.ts`
- Create: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create clinics.ts**

```typescript
import { pgTable, uuid, text, timestamp, jsonb, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const clinics = pgTable(
  'clinics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    plan: text('plan').notNull().default('trial'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'clinics_plan_check',
      sql`${t.plan} IN ('trial','starter','pro','enterprise')`,
    ),
  ],
);

export type Clinic = typeof clinics.$inferSelect;
export type NewClinic = typeof clinics.$inferInsert;
```

- [ ] **Step 2: Create clinic-members.ts**

```typescript
import { pgTable, uuid, text, timestamp, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clinics } from './clinics.js';

export const clinicMembers = pgTable(
  'clinic_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id').notNull().references(() => clinics.id),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull().default('member'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.clinicId, t.userId),
    check(
      'clinic_members_role_check',
      sql`${t.role} IN ('owner','admin','member')`,
    ),
  ],
);

export type ClinicMember = typeof clinicMembers.$inferSelect;
export type NewClinicMember = typeof clinicMembers.$inferInsert;
```

- [ ] **Step 3: Create audit-logs.ts**

```typescript
import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { clinics } from './clinics.js';

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull().references(() => clinics.id),
  userId: uuid('user_id'),
  action: text('action').notNull(),
  resource: text('resource').notNull(),
  resourceId: uuid('resource_id'),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
```

- [ ] **Step 4: Create schema/index.ts**

```typescript
export * from './clinics.js';
export * from './clinic-members.js';
export * from './audit-logs.js';
```

---

## Task 9: Create src/client.ts, src/index.ts, src/migrate.ts

**Files:**
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/index.ts`
- Create: `packages/db/src/migrate.ts`

- [ ] **Step 1: Create client.ts**

```typescript
import postgres from 'postgres';

export function createClient(connectionString: string): postgres.Sql {
  return postgres(connectionString, {
    max: 10,
    idle_timeout: 30,
  });
}
```

- [ ] **Step 2: Create index.ts**

```typescript
export { createClient } from './client.js';
export * from './schema/index.js';
```

- [ ] **Step 3: Create migrate.ts**

```typescript
import { readFileSync, readdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import * as dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../apps/web/.env.local') });

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set in apps/web/.env.local');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);
const migrationsDir = resolve(__dirname, '../migrations');

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const file of files) {
  const content = readFileSync(join(migrationsDir, file), 'utf-8');
  console.log(`Applying ${file}...`);
  await sql.unsafe(content);
  console.log(`  ✓ ${file}`);
}

await sql.end();
console.log('\nMigrations complete.');
```

---

## Task 10: Apply Migrations

- [ ] **Step 1: Verify DATABASE_URL is port 5432**

Check `apps/web/.env.local` — the `DATABASE_URL` must end in `:5432/postgres` (not `:6543`).  
If it uses the transaction pooler (6543), replace with the direct connection URL from Supabase dashboard → Project Settings → Database → Connection string → URI (direct).

- [ ] **Step 2: Run migrate**

Run: `pnpm --filter @medina/db migrate`

Expected output:
```
Applying 0000_core_schema.sql...
  ✓ 0000_core_schema.sql
Applying 0001_hardening.sql...
  ✓ 0001_hardening.sql

Migrations complete.
```

If any error occurs, STOP. Fix the SQL, then re-run. The migration is idempotent for tables (`CREATE TABLE IF NOT EXISTS`) but not for functions/policies — if re-running after partial failure, you may need to drop and recreate manually.

---

## Task 11: Run Tests — GREEN Phase

- [ ] **Step 1: Run all tests**

Run: `pnpm --filter @medina/db test`

Expected:
```
✓ packages/db/tests/rls/clinics.test.ts (4 tests)
✓ packages/db/tests/rls/clinic-members.test.ts (3 tests)
✓ packages/db/tests/rls/audit-logs.test.ts (3 tests)

Test Files  3 passed (3)
Tests       10 passed (10)
```

If any test fails, STOP. Read the error. Fix only the specific failure (SQL policy or test assertion). Re-run.

---

## Task 12: Validate Schema

- [ ] **Step 1: Check typecheck passes**

Run: `pnpm --filter @medina/db typecheck`
Expected: No errors.

- [ ] **Step 2: Verify RLS is forced on all tables**

Add a one-off validation query to `src/migrate.ts` or run via any postgres client:

```sql
SELECT tablename, rowsecurity, forcerowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('clinics', 'clinic_members', 'audit_logs')
ORDER BY tablename;
```

Expected: All 3 rows have `rowsecurity = true` AND `forcerowsecurity = true`.

- [ ] **Step 3: Check for security advisors**

This step uses the Supabase MCP `get_advisors` tool (if accessible) OR the Supabase dashboard → Advisors → Security.  
Any advisory about missing RLS policies on these 3 tables should now be gone.

---

## Task 13: Commit

- [ ] **Step 1: Stage and commit**

```bash
git add packages/db turbo.json
git commit -m "feat: issue 2 - core multi-tenant schema with rls and tests"
```

Expected: Commit created. Verify with `git log --oneline`.

---

## Self-Review

**Spec coverage:**
- ✅ A) packages/db bootstrapped (Tasks 1, 9)
- ✅ B) Plan written before code
- ✅ C) RLS tests written FIRST (Tasks 2–5), RED phase verified before migrations
- ✅ D) 0000_core_schema.sql with all required items (Task 6), 0001_hardening.sql (Task 7)
- ✅ E) Drizzle schemas for all 3 tables (Task 8)
- ✅ F) Applied via migrate.ts (Task 10) — MCP unavailable for this project, DATABASE_URL used instead
- ✅ G) Tests GREEN (Task 11)
- ✅ H) Validation: typecheck, RLS forced check, security advisors (Task 12)
- ✅ I) Commit (Task 13)

**No placeholders:** All steps contain actual code or exact commands.

**Type consistency:** `postgres.Sql` / `postgres.TransactionSql` used consistently across setup.ts and test files. All `.js` import extensions present for ESM compatibility.

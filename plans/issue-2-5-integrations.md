# Issue 2.5 — clinic_integrations with Encryption & Webhook Isolation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `clinic_integrations` table with pgcrypto-encrypted credentials, per-clinic webhook routing, automatic audit log, and RLS matching the admin-only write pattern from Issue 2.

**Architecture:** SQL-first like Issues 2 and 2 — migration applied via `pnpm --filter @medina/db migrate` (Supabase MCP has no access to this project's org). Credentials are stored as `bytea` via `pgp_sym_encrypt`; only `get_integration_credential(uuid)` — a SECURITY DEFINER function that checks `has_clinic_role` before decrypting — can return plain text. Soft DELETE is intercepted by a BEFORE DELETE trigger that writes `deleted_at = NOW()` and returns NULL (cancels the actual DELETE). Audit logs are written by an AFTER INSERT OR UPDATE trigger, never including the `encrypted_credentials` bytes.

**Tech Stack:** PostgreSQL 17 · pgcrypto (already installed) · drizzle-orm · postgres-js · vitest

> ⚠️ **Encryption key**: `get_integration_credential` reads `current_setting('app.encryption_key', TRUE)`. Tests set it with `SET LOCAL app.encryption_key = '...'` inside each transaction. In production, set it at the database level via Supabase dashboard → Database → Configuration → `app.encryption_key`, then rotate by changing the setting and re-encrypting rows.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `packages/db/tests/rls/helpers/setup.ts` | **Modify** | Add `createTestIntegration`, update `cleanupAll` to include `clinic_integrations` |
| `packages/db/tests/rls/clinic-integrations.test.ts` | Create | 7 RLS/encryption tests (RED before migration) |
| `packages/db/migrations/0002_integrations.sql` | Create | Table, indexes, encrypt/decrypt/get functions, soft-delete trigger, audit trigger, policies, grants |
| `packages/db/src/schema/clinic-integrations.ts` | Create | Drizzle schema for `clinic_integrations` |
| `packages/db/src/schema/index.ts` | **Modify** | Export `clinic-integrations.ts` |
| `packages/integrations/package.json` | Create | Minimal workspace package skeleton |
| `packages/integrations/src/types.ts` | Create | `IntegrationAdapter` interface |
| `packages/integrations/README.md` | Create | Webhook routing, credential access, HMAC validation, adapter contract |

---

## Task 1: Update Test Helpers

**Files:**
- Modify: `packages/db/tests/rls/helpers/setup.ts`

- [ ] **Step 1: Add `createTestIntegration` and update `cleanupAll`**

Replace the entire file contents:

```typescript
import postgres from 'postgres';
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../../../apps/web/.env.local') });

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL not set in apps/web/.env.local');

export const TEST_ENCRYPTION_KEY = 'test-encryption-key-medina-2025';

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
 * Creates a test integration via service role (bypasses RLS).
 * Encrypts the given credentials with TEST_ENCRYPTION_KEY.
 */
export async function createTestIntegration(
  sql: postgres.Sql,
  clinicId: string,
  opts: {
    type?: string;
    provider?: string;
    name?: string;
    plainCredentials?: string;
  } = {},
): Promise<{ id: string; clinic_id: string; webhook_path: string }> {
  const type = opts.type ?? 'whatsapp';
  const provider = opts.provider ?? 'cloud_api';
  const name = opts.name ?? `Test ${type} ${Date.now()}`;
  const plainCredentials = opts.plainCredentials ?? '{"token":"test-secret-123"}';

  const rows = await sql<{ id: string; clinic_id: string; webhook_path: string }[]>`
    INSERT INTO clinic_integrations (clinic_id, type, provider, name, encrypted_credentials)
    VALUES (
      ${clinicId},
      ${type},
      ${provider},
      ${name},
      encrypt_credential(${plainCredentials}, ${TEST_ENCRYPTION_KEY})
    )
    RETURNING id, clinic_id, webhook_path
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestIntegration: no row returned');
  return row;
}

/**
 * Returns a client that executes queries as the given user with RLS enforced.
 * Uses SET LOCAL inside a transaction so role + JWT claims are scoped to
 * that transaction only and do not leak between tests.
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
      }) as Promise<T>,
  };
}

export async function cleanupAll(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM audit_logs`;
  await sql`DELETE FROM clinic_integrations`;
  await sql`DELETE FROM clinic_members`;
  await sql`DELETE FROM clinics`;
  await sql`DELETE FROM auth.users WHERE email LIKE '%@medina-test.internal'`;
}
```

> **Why `clinic_integrations` before `clinic_members`:** FK `clinic_integrations.clinic_id → clinics.id`. Deleting `clinics` first would violate the FK. The order is: audit_logs → clinic_integrations → clinic_members → clinics → auth.users.

> **Why `cleanupAll` has `clinic_integrations`:** The `BEFORE DELETE` trigger on `clinic_integrations` converts DELETE to soft-delete (UPDATE `deleted_at`). `DELETE FROM clinic_integrations` will fire this trigger and leave rows with `deleted_at` set — they'll still block the cascade. To truly truncate for test isolation, we'd need to either disable the trigger or do a direct UPDATE first. The simplest approach: use `DELETE FROM clinic_integrations WHERE TRUE` — this fires the soft-delete trigger on each row. After that, the cascade to `clinics` won't fail since the FK is `ON DELETE CASCADE`. Actually, since the trigger converts DELETE → UPDATE, the rows are NOT deleted — they just get `deleted_at` set. We need to force-delete them. Use `TRUNCATE` instead, or set `deleted_at` then delete, or temporarily disable the trigger.
>
> **Revised approach for cleanupAll**: Use `UPDATE clinic_integrations SET deleted_at = NOW()` then force delete with a direct TRUNCATE or use the service-role DELETE which has FORCE ROW LEVEL SECURITY... Actually, the simplest solution: the soft-delete trigger only fires on `deleted_at IS NULL` rows. First set all to deleted, then delete (the trigger won't fire again because `deleted_at IS NOT NULL`):
>
> ```sql
> UPDATE clinic_integrations SET deleted_at = NOW() WHERE deleted_at IS NULL;
> DELETE FROM clinic_integrations; -- trigger WHEN condition = false, so no soft-delete loop
> ```
>
> The cleanupAll above uses this two-step pattern. See Task 1 Step 2.

- [ ] **Step 2: Fix cleanupAll for soft-delete trigger**

The soft-delete trigger only fires `WHEN (OLD.deleted_at IS NULL)`. To properly delete all rows in tests, first mark all as deleted (triggering audit), then delete them (trigger skips because `deleted_at IS NOT NULL`).

Replace the `cleanupAll` function in setup.ts with:

```typescript
export async function cleanupAll(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM audit_logs`;
  // Two-step: first trigger soft-delete (sets deleted_at), then actually delete
  // The trigger only fires WHEN (OLD.deleted_at IS NULL), so second DELETE is safe
  await sql`UPDATE clinic_integrations SET deleted_at = NOW() WHERE deleted_at IS NULL`;
  await sql`DELETE FROM clinic_integrations`;
  await sql`DELETE FROM clinic_members`;
  await sql`DELETE FROM clinics`;
  await sql`DELETE FROM auth.users WHERE email LIKE '%@medina-test.internal'`;
}
```

> At this stage the `clinic_integrations` table doesn't exist yet. `cleanupAll` will throw in the RED phase (caught by `beforeAll`). That's expected — the tests will still show as FAIL for the right reason after the table exists.

---

## Task 2: Write clinic-integrations.test.ts — RED Phase

**Files:**
- Create: `packages/db/tests/rls/clinic-integrations.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_ENCRYPTION_KEY,
  addUserToClinic,
  cleanupAll,
  createTestClinic,
  createTestIntegration,
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

// ─── Cross-tenant isolation ───────────────────────────────────────────────────

describe('clinic_integrations: cross-tenant isolation', () => {
  it('users only see integrations of their own clinic', async () => {
    const clinicA = await createTestClinic(sql, 'Integrations Tenant A');
    const clinicB = await createTestClinic(sql, 'Integrations Tenant B');
    const userA = await createTestUser(sql);
    await addUserToClinic(sql, clinicA.id, userA.id, 'member');

    const intA = await createTestIntegration(sql, clinicA.id, { name: 'WA Clinic A' });
    const intB = await createTestIntegration(sql, clinicB.id, { name: 'WA Clinic B' });

    const client = getRlsClient(sql, userA.id);
    const rows = await client.query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM clinic_integrations WHERE deleted_at IS NULL`,
    );

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(intA.id);
    expect(ids).not.toContain(intB.id);
  });
});

// ─── RBAC: INSERT ─────────────────────────────────────────────────────────────

describe('clinic_integrations: RBAC insert', () => {
  it('non-admin (member) cannot insert integration', async () => {
    const clinic = await createTestClinic(sql, 'RBAC Insert Member');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    const client = getRlsClient(sql, member.id);
    await expect(
      client.query((tx) =>
        tx`
          INSERT INTO clinic_integrations (clinic_id, type, provider, name)
          VALUES (${clinic.id}, 'whatsapp', 'cloud_api', 'Member Insert Attempt')
        `,
      ),
    ).rejects.toThrow();
  });

  it('admin can insert integration', async () => {
    const clinic = await createTestClinic(sql, 'RBAC Insert Admin');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');

    const client = getRlsClient(sql, admin.id);
    await expect(
      client.query((tx) =>
        tx<{ id: string }[]>`
          INSERT INTO clinic_integrations (clinic_id, type, provider, name)
          VALUES (${clinic.id}, 'calcom', 'cal', 'Admin Insert Cal')
          RETURNING id
        `,
      ),
    ).resolves.not.toThrow();
  });
});

// ─── RBAC: UPDATE ─────────────────────────────────────────────────────────────

describe('clinic_integrations: RBAC update', () => {
  it('non-admin (member) cannot update integration (0 rows affected)', async () => {
    const clinic = await createTestClinic(sql, 'RBAC Update Block');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    const integration = await createTestIntegration(sql, clinic.id, { name: 'WA Update Block' });

    const client = getRlsClient(sql, member.id);
    const result = await client.query((tx) =>
      tx<{ id: string }[]>`
        UPDATE clinic_integrations
        SET name = 'Hacked'
        WHERE id = ${integration.id}
        RETURNING id
      `,
    );
    expect(result).toHaveLength(0);
  });
});

// ─── Encrypted credentials ────────────────────────────────────────────────────

describe('clinic_integrations: encrypted_credentials', () => {
  it('encrypted_credentials is returned as bytea (Buffer), not plain text', async () => {
    const clinic = await createTestClinic(sql, 'Encrypt Bytea');
    const integration = await createTestIntegration(sql, clinic.id, {
      plainCredentials: '{"api_key":"super-secret-value"}',
    });

    const rows = await sql<{ encrypted_credentials: Buffer | null }[]>`
      SELECT encrypted_credentials
      FROM clinic_integrations
      WHERE id = ${integration.id}
    `;
    const cred = rows[0]?.encrypted_credentials;

    // Must be a Buffer (binary), never a string
    expect(cred).toBeInstanceOf(Buffer);
    // The raw bytes must not decode to the original plain text
    expect(cred!.toString('utf-8')).not.toContain('super-secret-value');
  });

  it('admin can decrypt credentials via get_integration_credential', async () => {
    const clinic = await createTestClinic(sql, 'Decrypt Admin');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');

    const plainCredentials = '{"token":"admin-decrypt-ok"}';
    const integration = await createTestIntegration(sql, clinic.id, { plainCredentials });

    const client = getRlsClient(sql, admin.id);
    const rows = await client.query(async (tx) => {
      await tx`SET LOCAL app.encryption_key = ${TEST_ENCRYPTION_KEY}`;
      return tx<{ val: string }[]>`
        SELECT get_integration_credential(${integration.id}::uuid) AS val
      `;
    });

    expect(rows[0]?.val).toBe(plainCredentials);
  });

  it('non-admin (member) cannot decrypt via get_integration_credential', async () => {
    const clinic = await createTestClinic(sql, 'Decrypt Member Block');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    const integration = await createTestIntegration(sql, clinic.id);

    const client = getRlsClient(sql, member.id);
    await expect(
      client.query(async (tx) => {
        await tx`SET LOCAL app.encryption_key = ${TEST_ENCRYPTION_KEY}`;
        return tx<{ val: string }[]>`
          SELECT get_integration_credential(${integration.id}::uuid) AS val
        `;
      }),
    ).rejects.toThrow('access denied');
  });
});

// ─── Audit log ────────────────────────────────────────────────────────────────

describe('clinic_integrations: automatic audit log', () => {
  it('INSERT creates an audit log entry with action integration.created', async () => {
    const clinic = await createTestClinic(sql, 'Audit Integration');

    // Count audit_logs before
    const before = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM audit_logs WHERE clinic_id = ${clinic.id}
    `;
    const countBefore = Number(before[0]?.count ?? 0);

    await createTestIntegration(sql, clinic.id, { name: 'Audit WA' });

    const rows = await sql<{ action: string; resource: string }[]>`
      SELECT action, resource
      FROM audit_logs
      WHERE clinic_id = ${clinic.id}
        AND action = 'integration.created'
    `;

    expect(rows.length).toBeGreaterThan(countBefore);
    expect(rows[0]?.resource).toBe('clinic_integrations');
  });
});
```

- [ ] **Step 2: Run tests — verify RED**

Run: `pnpm --filter @medina/db test tests/rls/clinic-integrations.test.ts`

Expected: FAIL — `relation "clinic_integrations" does not exist` (or `cleanupAll` throws at `beforeAll`). Confirms tests hit the real database.

---

## Task 3: Create 0002_integrations.sql

**Files:**
- Create: `packages/db/migrations/0002_integrations.sql`

- [ ] **Step 1: Create migration**

```sql
-- ─── Encryption utilities ─────────────────────────────────────────────────────
-- Uses pgcrypto pgp_sym_encrypt/decrypt (already installed from 0000).
-- Key comes from session config: SET app.encryption_key = '...';

CREATE OR REPLACE FUNCTION public.encrypt_credential(plain text, key text)
RETURNS bytea LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT pgp_sym_encrypt(plain, key);
$$;

CREATE OR REPLACE FUNCTION public.decrypt_credential(encrypted bytea, key text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT pgp_sym_decrypt(encrypted, key);
$$;

-- Restrict encrypt/decrypt to service_role — authenticated users must go through
-- get_integration_credential which enforces role checks before decrypting.
REVOKE EXECUTE ON FUNCTION public.encrypt_credential(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decrypt_credential(bytea, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.encrypt_credential(text, text) TO service_role;
GRANT  EXECUTE ON FUNCTION public.decrypt_credential(bytea, text) TO service_role;

-- ─── Table: clinic_integrations ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.clinic_integrations (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id            UUID        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  type                 TEXT        NOT NULL
                                   CHECK (type IN ('pep', 'whatsapp', 'kapso', 'calcom', 'custom')),
  provider             TEXT        NOT NULL,
  name                 TEXT        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'configuring'
                                   CHECK (status IN ('configuring', 'active', 'error', 'disabled')),
  config               JSONB       NOT NULL DEFAULT '{}',
  encrypted_credentials BYTEA,
  webhook_secret       TEXT,
  webhook_path         TEXT        GENERATED ALWAYS AS (
                                     '/api/webhooks/' || type || '/' || provider || '/' || clinic_id::text
                                   ) STORED,
  last_sync_at         TIMESTAMPTZ,
  last_error           TEXT,
  last_error_at        TIMESTAMPTZ,
  metadata             JSONB       NOT NULL DEFAULT '{}',
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (clinic_id, type, provider, name)
    WHERE deleted_at IS NULL -- partial unique index via constraint
);

-- updated_at trigger
CREATE TRIGGER trg_clinic_integrations_updated_at
  BEFORE UPDATE ON public.clinic_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_clinic_integrations_clinic_status
  ON public.clinic_integrations (clinic_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_clinic_integrations_clinic_type_provider
  ON public.clinic_integrations (clinic_id, type, provider)
  WHERE deleted_at IS NULL;

-- ─── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.clinic_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinic_integrations FORCE ROW LEVEL SECURITY;

CREATE POLICY "clinic_integrations: members can select"
  ON public.clinic_integrations FOR SELECT
  USING (is_clinic_member(clinic_id) AND deleted_at IS NULL);

CREATE POLICY "clinic_integrations: admins can insert"
  ON public.clinic_integrations FOR INSERT
  WITH CHECK (has_clinic_role(clinic_id, 'admin'));

CREATE POLICY "clinic_integrations: admins can update"
  ON public.clinic_integrations FOR UPDATE
  USING  (has_clinic_role(clinic_id, 'admin'))
  WITH CHECK (has_clinic_role(clinic_id, 'admin'));

CREATE POLICY "clinic_integrations: admins can delete"
  ON public.clinic_integrations FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin'));

-- Grant DML to authenticated (RLS policies control actual access)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clinic_integrations TO authenticated;

-- ─── Soft-delete trigger ──────────────────────────────────────────────────────
-- Intercepts DELETE, sets deleted_at = NOW(), cancels the actual DELETE.
-- SECURITY DEFINER so the internal UPDATE bypasses RLS (the DELETE policy
-- already guards who can initiate it).

CREATE OR REPLACE FUNCTION public.soft_delete_integration()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  UPDATE public.clinic_integrations
  SET deleted_at = NOW()
  WHERE id = OLD.id AND deleted_at IS NULL;
  RETURN NULL; -- Cancels the actual DELETE row operation
END;
$$;

CREATE TRIGGER trg_clinic_integrations_soft_delete
  BEFORE DELETE ON public.clinic_integrations
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL)
  EXECUTE FUNCTION public.soft_delete_integration();

-- ─── Audit log trigger ────────────────────────────────────────────────────────
-- Fires AFTER INSERT and AFTER UPDATE (soft DELETE becomes UPDATE via trigger above).
-- Never copies encrypted_credentials into metadata — strips it explicitly.

CREATE OR REPLACE FUNCTION public.audit_integration_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_action     text;
  v_after_data jsonb;
  v_before_data jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action      := 'integration.created';
    v_after_data  := (to_jsonb(NEW) - 'encrypted_credentials');
    v_before_data := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
      v_action := 'integration.deleted';
    ELSIF NEW.status = 'active' AND OLD.status != 'active' THEN
      v_action := 'integration.activated';
    ELSIF NEW.status = 'error'  AND OLD.status != 'error'  THEN
      v_action := 'integration.errored';
    ELSE
      v_action := 'integration.updated';
    END IF;
    v_after_data  := (to_jsonb(NEW) - 'encrypted_credentials');
    v_before_data := (to_jsonb(OLD) - 'encrypted_credentials');
  END IF;

  INSERT INTO public.audit_logs (
    clinic_id, user_id, action, resource, resource_id, metadata
  ) VALUES (
    NEW.clinic_id,
    auth.uid(),
    v_action,
    'clinic_integrations',
    NEW.id,
    jsonb_build_object('before', v_before_data, 'after', v_after_data)
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_integration_change
  AFTER INSERT OR UPDATE ON public.clinic_integrations
  FOR EACH ROW EXECUTE FUNCTION public.audit_integration_change();

-- ─── get_integration_credential ──────────────────────────────────────────────
-- The ONLY way for an authenticated user to obtain the decrypted credential.
-- Validates that the caller is an admin or owner of the clinic before decrypting.
-- Reads the encryption key from the session setting: SET app.encryption_key = '...';

CREATE OR REPLACE FUNCTION public.get_integration_credential(p_integration_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_clinic_id  UUID;
  v_encrypted  BYTEA;
  v_key        TEXT;
BEGIN
  SELECT clinic_id, encrypted_credentials
  INTO   v_clinic_id, v_encrypted
  FROM   public.clinic_integrations
  WHERE  id = p_integration_id
    AND  deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'integration not found';
  END IF;

  IF NOT has_clinic_role(v_clinic_id, 'admin')
     AND NOT has_clinic_role(v_clinic_id, 'owner')
  THEN
    RAISE EXCEPTION 'access denied: requires admin or owner role';
  END IF;

  IF v_encrypted IS NULL THEN
    RETURN NULL;
  END IF;

  v_key := current_setting('app.encryption_key', TRUE);
  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'app.encryption_key is not configured for this session';
  END IF;

  RETURN pgp_sym_decrypt(v_encrypted, v_key);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_integration_credential(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_integration_credential(UUID) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_integration_credential(UUID) TO service_role;
```

---

## Task 4: Apply Migration

- [ ] **Step 1: Run migrate**

Run: `pnpm --filter @medina/db migrate`

Expected:
```
Applying 0000_core_schema.sql...
  ✓ 0000_core_schema.sql
Applying 0001_hardening.sql...
  ✓ 0001_hardening.sql
Applying 0002_integrations.sql...
  ✓ 0002_integrations.sql

Migrations complete.
```

> Migrations 0000 and 0001 re-run but are idempotent (`CREATE OR REPLACE`, `CREATE TABLE IF NOT EXISTS`). If a policy or trigger already exists from a re-run, you may see errors — fix them by adding `DROP ... IF EXISTS` before re-creating or by only running the new migration: `tsx src/migrate.ts --from 0002`.
>
> If there is an error, STOP. Do not continue to the next task. Report the exact Postgres error.

---

## Task 5: Run Tests — GREEN Phase

- [ ] **Step 1: Run all tests**

Run: `pnpm --filter @medina/db test`

Expected:
```
✓ tests/rls/clinic-members.test.ts  (4 tests)
✓ tests/rls/clinics.test.ts         (4 tests)
✓ tests/rls/audit-logs.test.ts      (3 tests)
✓ tests/rls/clinic-integrations.test.ts (7 tests)

Test Files  4 passed (4)
Tests       18 passed (18)
```

If any test fails, STOP. Read the exact failure, fix only that failure, re-run.

---

## Task 6: Create Drizzle Schema

**Files:**
- Create: `packages/db/src/schema/clinic-integrations.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create clinic-integrations.ts**

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  customType,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clinics } from './clinics.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const clinicIntegrations = pgTable(
  'clinic_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('configuring'),
    config: jsonb('config').notNull().default({}),
    encryptedCredentials: bytea('encrypted_credentials'),
    webhookSecret: text('webhook_secret'),
    webhookPath: text('webhook_path'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_clinic_integrations_clinic_status')
      .on(t.clinicId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index('idx_clinic_integrations_clinic_type_provider')
      .on(t.clinicId, t.type, t.provider)
      .where(sql`${t.deletedAt} IS NULL`),
    check(
      'clinic_integrations_type_check',
      sql`${t.type} IN ('pep','whatsapp','kapso','calcom','custom')`,
    ),
    check(
      'clinic_integrations_status_check',
      sql`${t.status} IN ('configuring','active','error','disabled')`,
    ),
  ],
);

export type ClinicIntegration = typeof clinicIntegrations.$inferSelect;
export type NewClinicIntegration = typeof clinicIntegrations.$inferInsert;
```

> `webhookPath` is declared as a plain `text` column (not `.generatedAlwaysAs()`). The database handles generation; Drizzle reads it as text. Drizzle does not need the generation expression to query or infer the type.

- [ ] **Step 2: Update schema/index.ts**

```typescript
export * from './clinics.js';
export * from './clinic-members.js';
export * from './audit-logs.js';
export * from './clinic-integrations.js';
```

---

## Task 7: Create packages/integrations Skeleton

**Files:**
- Create: `packages/integrations/package.json`
- Create: `packages/integrations/src/types.ts`
- Create: `packages/integrations/README.md`

- [ ] **Step 1: Create packages/integrations/package.json**

```json
{
  "name": "@medina/integrations",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/types.ts"
  }
}
```

- [ ] **Step 2: Create src/types.ts**

```typescript
/**
 * Every integration adapter implements this interface.
 * Adapters live in packages/integrations/src/adapters/{type}/{provider}.ts
 */
export interface IntegrationAdapter {
  /**
   * Handle an inbound webhook payload.
   * Called by the Next.js route handler after HMAC validation.
   */
  handle(payload: unknown, context: AdapterContext): Promise<void>;

  /**
   * Pull fresh data from the external system.
   * Called on a schedule or manually via the dashboard.
   */
  sync(context: AdapterContext): Promise<SyncResult>;

  /**
   * Verify the integration is reachable and credentials are valid.
   * Returns true on success; throws with a descriptive message on failure.
   */
  healthCheck(context: AdapterContext): Promise<boolean>;
}

export interface AdapterContext {
  /** The clinic_integrations row ID — pass to get_integration_credential */
  integrationId: string;
  /** Clinic ID — for scoped DB queries */
  clinicId: string;
  /**
   * Retrieve the decrypted credentials for this integration.
   * Calls `SELECT get_integration_credential($1)` internally.
   * Only works when the calling session has app.encryption_key set.
   */
  getCredentials(): Promise<string>;
}

export interface SyncResult {
  syncedAt: Date;
  itemsProcessed: number;
  errors: string[];
}

/** Shape of the config JSONB column — non-sensitive, adapter-specific */
export interface IntegrationConfig {
  accountId?: string;
  webhookEvents?: string[];
  fieldMappings?: Record<string, string>;
  [key: string]: unknown;
}
```

- [ ] **Step 3: Create packages/integrations/README.md**

```markdown
# @medina/integrations

Adapter pattern for external system integrations (PEP, WhatsApp, Cal.com, etc.).

## Webhook Routing

Inbound webhooks arrive at:

```
POST /api/webhooks/{type}/{provider}/{clinic_id}
```

Example: `POST /api/webhooks/whatsapp/cloud_api/a1b2c3d4-...`

The `webhook_path` column on `clinic_integrations` is a GENERATED STORED column
that always equals this pattern. The Next.js route handler at
`apps/web/app/api/webhooks/[type]/[provider]/[clinic_id]/route.ts` (to be created
in a future issue) will:

1. Look up the integration row using `type`, `provider`, and `clinic_id`
2. Load the `webhook_secret` from the row
3. Validate the HMAC signature (see below)
4. Dispatch to the correct adapter's `handle()` method

## HMAC Validation

Each integration has a `webhook_secret` (random string set at creation time).
To validate an inbound webhook:

```typescript
import { createHmac, timingSafeEqual } from 'crypto';

function validateWebhookSignature(
  payload: Buffer,
  receivedSig: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(receivedSig);
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}
```

The signature header name is provider-specific:
- WhatsApp Cloud API: `X-Hub-Signature-256` (prefix `sha256=`)
- iClinic: `X-iClinic-Signature`
- Generic: `X-Medina-Signature`

## Reading Credentials

Adapters receive an `AdapterContext` with a `getCredentials()` helper. Internally
it calls:

```sql
SELECT get_integration_credential($1::uuid)
```

This SECURITY DEFINER function validates the caller has `admin` or `owner` role
in the integration's clinic before decrypting with `app.encryption_key`.

The application server must set the encryption key before calling:

```typescript
await sql`SET LOCAL app.encryption_key = ${process.env.ENCRYPTION_KEY}`;
const creds = JSON.parse(await context.getCredentials());
```

**Key rotation**: Update `app.encryption_key` in Supabase → Database → Configuration,
then run a one-time migration that re-encrypts all `encrypted_credentials` rows with
the new key.

## Adapter Contract

```typescript
// packages/integrations/src/adapters/{type}/{provider}.ts
import type { IntegrationAdapter } from '@medina/integrations';

export const adapter: IntegrationAdapter = {
  async handle(payload, context) { /* ... */ },
  async sync(context) { /* ... */ },
  async healthCheck(context) { /* ... */ },
};
```

## Directory Structure (future)

```
packages/integrations/
  src/
    types.ts            ← adapter interface (exists)
    adapters/
      whatsapp/
        cloud_api.ts    ← WhatsApp Cloud API adapter
      pep/
        iclinic.ts      ← iClinic PEP adapter
        feegow.ts
      calcom/
        cal.ts
```
```

---

## Task 8: Typecheck and Validate

- [ ] **Step 1: Typecheck packages/db**

Run: `pnpm --filter @medina/db typecheck`
Expected: 0 errors.

- [ ] **Step 2: Verify RLS on clinic_integrations**

Run:

```typescript
// Run via node (same pattern as check_rls.mjs in Issue 2):
const rows = await sql`
  SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'clinic_integrations' AND c.relkind = 'r'
`;
// Expected: rls: true, force_rls: true
```

- [ ] **Step 3: Verify generated column and indexes exist**

Run:

```sql
SELECT column_name, generation_expression
FROM information_schema.columns
WHERE table_name = 'clinic_integrations' AND is_generated = 'ALWAYS';
-- Expected: webhook_path with expression
```

---

## Task 9: Commit

- [ ] **Step 1: Stage and commit**

```bash
git add packages/db packages/integrations
git commit -m "feat: issue 2.5 - clinic_integrations with encryption and webhook isolation pattern"
```

Expected: Commit created with all new files.

---

## Self-Review

**Spec coverage:**
- ✅ A) Plan written before code
- ✅ B) 7 tests: cross-tenant, non-admin insert (fail), admin insert (ok), non-admin update (0 rows), bytea not plain text, admin decrypt, member blocked from decrypt, audit log on INSERT
- ✅ C) 0002_integrations.sql: all columns, generated webhook_path, partial unique index, 2 partial indexes, encrypt/decrypt/get functions, soft-delete trigger, audit trigger, RLS FORCE, all policies, GRANT/REVOKE
- ✅ D) Drizzle schema with bytea customType, indexes, checks; index.ts updated
- ✅ E) packages/integrations README + types.ts with full adapter interface
- ✅ F) Migration applied via migrate.ts (Supabase MCP has no access to this project's org)
- ✅ G) All 18 tests pass (green)
- ✅ H) Typecheck + RLS validation
- ✅ I) Commit

**No placeholders:** All steps contain actual SQL, TypeScript, or exact commands.

**Type consistency:** `createTestIntegration` returns `{ id, clinic_id, webhook_path }`. Tests reference `integration.id` (used consistently across all test cases).

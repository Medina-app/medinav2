# Issue 8 — Patients Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the shared `patients` table with CPF encryption, RLS, soft-delete, and audit logging.

**Architecture:** SQL migration first (source of truth), then Drizzle schema mirrors it. CPF encrypted via pgcrypto reusing `app.encryption_key` session setting established in Issue 2.5. `get_patient_cpf` SECURITY DEFINER function is the only path to plaintext CPF.

**Tech Stack:** PostgreSQL · pgcrypto · pg_trgm · Drizzle ORM · Vitest · postgres.js

---

### Task 1: Write failing tests

**Files:**
- Create: `packages/db/tests/rls/patients.test.ts`
- Modify: `packages/db/tests/rls/helpers/setup.ts` (add `createTestPatient`, update `cleanupAll`)

- [ ] Add `createTestPatient` helper to `setup.ts` after `createTestIntegration`:

```typescript
export async function createTestPatient(
  sql: postgres.Sql,
  clinicId: string,
  opts: { phone?: string; fullName?: string } = {},
): Promise<{ id: string; clinic_id: string }> {
  const phone = opts.phone ?? `+5511${Date.now().toString().slice(-9)}`;
  const fullName = opts.fullName ?? `Patient ${Date.now()}`;
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO patients (clinic_id, full_name, phone)
    VALUES (${clinicId}, ${fullName}, ${phone})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestPatient: no row returned');
  return row;
}
```

- [ ] Update `cleanupAll` — prepend patients cleanup before audit_logs:

```typescript
await sql`UPDATE patients SET deleted_at = NOW() WHERE deleted_at IS NULL`;
await sql`DELETE FROM patients`;
```

- [ ] Create `packages/db/tests/rls/patients.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic, cleanupAll, createTestClinic, createTestPatient,
  createTestUser, getRlsClient, getServiceClient, TEST_ENCRYPTION_KEY,
} from './helpers/setup.js';

const sql = getServiceClient();
beforeAll(async () => { await cleanupAll(sql); });
afterAll(async () => { await cleanupAll(sql); await sql.end(); });

describe('patients: cross-tenant isolation', () => {
  it('users only see patients of their clinic', async () => {
    const cA = await createTestClinic(sql, 'Pat A');
    const cB = await createTestClinic(sql, 'Pat B');
    const uA = await createTestUser(sql);
    const uB = await createTestUser(sql);
    await addUserToClinic(sql, cA.id, uA.id);
    await addUserToClinic(sql, cB.id, uB.id);
    const pA = await createTestPatient(sql, cA.id);
    await createTestPatient(sql, cB.id);

    const rows = await getRlsClient(sql, uA.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM patients`,
    );
    expect(rows.map((r) => r.id)).toEqual([pA.id]);
  });
});

describe('patients: insert permissions', () => {
  it('non-member cannot insert patient', async () => {
    const clinic = await createTestClinic(sql, 'Pat NM');
    const stranger = await createTestUser(sql);
    await expect(
      getRlsClient(sql, stranger.id).query((tx) =>
        tx`INSERT INTO patients (clinic_id, full_name, phone) VALUES (${clinic.id}, 'X', '+5511900000001')`,
      ),
    ).rejects.toThrow();
  });

  it('member can insert patient', async () => {
    const clinic = await createTestClinic(sql, 'Pat Mem');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    await expect(
      getRlsClient(sql, member.id).query((tx) =>
        tx`INSERT INTO patients (clinic_id, full_name, phone) VALUES (${clinic.id}, 'Ana Lima', '+5511900000002')`,
      ),
    ).resolves.not.toThrow();
  });
});

describe('patients: soft delete', () => {
  it('deleted_at is set, row filtered from SELECT', async () => {
    const clinic = await createTestClinic(sql, 'Pat SD');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');
    const p = await createTestPatient(sql, clinic.id);

    await getRlsClient(sql, admin.id).query((tx) =>
      tx`DELETE FROM patients WHERE id = ${p.id}`,
    );

    const gone = await getRlsClient(sql, admin.id).query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM patients WHERE id = ${p.id}`,
    );
    expect(gone).toHaveLength(0);

    const still = await sql<{ deleted_at: string | null }[]>`
      SELECT deleted_at FROM patients WHERE id = ${p.id}
    `;
    expect(still[0]?.deleted_at).not.toBeNull();
  });
});

describe('patients: CPF encryption', () => {
  it('encrypted_cpf is never plain text in SELECT', async () => {
    const clinic = await createTestClinic(sql, 'Pat CPF');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');

    await sql`SET app.encryption_key = ${TEST_ENCRYPTION_KEY}`;
    await sql`
      INSERT INTO patients (clinic_id, full_name, phone, encrypted_cpf, cpf_hash)
      VALUES (${clinic.id}, 'Enc Test', '+5511900000003',
              encrypt_cpf('123.456.789-00', ${TEST_ENCRYPTION_KEY}),
              hash_cpf('123.456.789-00'))
    `;

    const rows = await getRlsClient(sql, admin.id).query((tx) =>
      tx<{ encrypted_cpf: unknown }[]>`SELECT encrypted_cpf FROM patients WHERE clinic_id = ${clinic.id}`,
    );
    // encrypted_cpf is bytea — must not contain the raw CPF string
    for (const r of rows) {
      const val = r.encrypted_cpf;
      if (val != null) {
        expect(String(val)).not.toContain('123.456.789-00');
      }
    }
  });

  it('get_patient_cpf decrypts for admin', async () => {
    const clinic = await createTestClinic(sql, 'Pat Dec');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');

    await sql`SET app.encryption_key = ${TEST_ENCRYPTION_KEY}`;
    const rows = await sql<{ id: string }[]>`
      INSERT INTO patients (clinic_id, full_name, phone, encrypted_cpf, cpf_hash)
      VALUES (${clinic.id}, 'Dec Test', '+5511900000004',
              encrypt_cpf('987.654.321-00', ${TEST_ENCRYPTION_KEY}),
              hash_cpf('987.654.321-00'))
      RETURNING id
    `;
    const pid = rows[0]!.id;

    const result = await getRlsClient(sql, admin.id).query((tx) =>
      tx<{ get_patient_cpf: string }[]>`
        SELECT get_patient_cpf(${pid}::uuid)
      `,
    );
    expect(result[0]?.get_patient_cpf).toBe('987.654.321-00');
  });

  it('get_patient_cpf is denied for plain member', async () => {
    const clinic = await createTestClinic(sql, 'Pat DecDeny');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    await sql`SET app.encryption_key = ${TEST_ENCRYPTION_KEY}`;
    const rows = await sql<{ id: string }[]>`
      INSERT INTO patients (clinic_id, full_name, phone, encrypted_cpf, cpf_hash)
      VALUES (${clinic.id}, 'Deny Test', '+5511900000005',
              encrypt_cpf('111.222.333-44', ${TEST_ENCRYPTION_KEY}),
              hash_cpf('111.222.333-44'))
      RETURNING id
    `;
    const pid = rows[0]!.id;

    await expect(
      getRlsClient(sql, member.id).query((tx) =>
        tx`SELECT get_patient_cpf(${pid}::uuid)`,
      ),
    ).rejects.toThrow();
  });
});

describe('patients: phone uniqueness per clinic', () => {
  it('duplicate phone in same clinic is rejected', async () => {
    const clinic = await createTestClinic(sql, 'Pat Phone');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');
    await createTestPatient(sql, clinic.id, { phone: '+5511900000006' });

    await expect(
      createTestPatient(sql, clinic.id, { phone: '+5511900000006' }),
    ).rejects.toThrow();
  });

  it('same phone in different clinics is allowed', async () => {
    const cA = await createTestClinic(sql, 'Pat PhoneA');
    const cB = await createTestClinic(sql, 'Pat PhoneB');
    await expect(
      Promise.all([
        createTestPatient(sql, cA.id, { phone: '+5511900000007' }),
        createTestPatient(sql, cB.id, { phone: '+5511900000007' }),
      ]),
    ).resolves.not.toThrow();
  });
});

describe('patients: audit log', () => {
  it('INSERT creates patient.created audit entry', async () => {
    const clinic = await createTestClinic(sql, 'Pat Audit');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');
    const p = await createTestPatient(sql, clinic.id);

    const logs = await sql<{ action: string; metadata: Record<string, unknown> }[]>`
      SELECT action, metadata FROM audit_logs
      WHERE resource_id = ${p.id} AND action = 'patient.created'
    `;
    expect(logs).toHaveLength(1);
    const meta = logs[0]!.metadata as { after?: Record<string, unknown> };
    expect(meta.after).not.toHaveProperty('encrypted_cpf');
    expect(meta.after).not.toHaveProperty('cpf_hash');
  });
});
```

- [ ] Run tests to confirm FAIL (table doesn't exist yet):
```
pnpm --filter @medina/db test tests/rls/patients.test.ts
```
Expected: errors like `relation "patients" does not exist`

---

### Task 2: Write migration 0004_patients.sql

**Files:**
- Create: `packages/db/migrations/0004_patients.sql`

- [ ] Create the file with the full SQL (see spec). Key points:
  - `encrypt_cpf` / `decrypt_cpf` / `hash_cpf` reuse `app.encryption_key` pattern from `0002_integrations.sql`
  - Soft-delete trigger mirrors `soft_delete_integration()`
  - Audit trigger strips `encrypted_cpf` AND `cpf_hash` from before/after data
  - `get_patient_cpf` validates `has_clinic_role(clinic_id, 'admin')` OR `has_clinic_role(clinic_id, 'owner')`
  - pg_trgm index uses `gin_trgm_ops`

---

### Task 3: Write Drizzle schema

**Files:**
- Create: `packages/db/src/schema/patients.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] Create schema following `clinic-integrations.ts` pattern with `customType` for `bytea`
- [ ] Add `export * from './patients.js';` to `index.ts`

---

### Task 4: Apply migration via Supabase MCP

- [ ] Apply `0004_patients.sql` via `mcp__supabase-medina__apply_migration`

---

### Task 5: Run tests — green

- [ ] `pnpm --filter @medina/db test tests/rls/patients.test.ts`
- [ ] All tests pass

---

### Task 6: Validate advisors

- [ ] `mcp__supabase-medina__get_advisors` — zero new critical warnings

---

### Task 7: Commit

- [ ] `git add packages/db/migrations/0004_patients.sql packages/db/src/schema/patients.ts packages/db/src/schema/index.ts packages/db/tests/rls/patients.test.ts packages/db/tests/rls/helpers/setup.ts`
- [ ] `git commit -m "feat: issue 8 - patients schema with cpf encryption and rls"`

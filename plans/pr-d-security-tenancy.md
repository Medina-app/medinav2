# PR-D Security & Tenancy Backlog Implementation Plan

> **For agentic workers:** Execute task-by-task. Each task is a single commit. TDD required: RED → verify fail → GREEN → verify pass → commit.

**Goal:** Endereça 5 issues de segurança/multi-tenant acumuladas desde PR-A: onboarding atomicidade, escalable user lookup, defense-in-depth no UPDATE de integrações WhatsApp, testes cross-tenant explícitos, e correção da flag `escalated` no dispatcher.

**Architecture:** 2 migrations Postgres (0033 RPC atômica de onboarding + 0034 trigger imutabilidade de `clinic_integrations.clinic_id`), refactors em 2 server actions Next, ajuste de lógica em 1 dispatcher AI, 1 ajuste em adapter Kapso, 3 conjuntos de testes (DB integration + unit + adapter).

**Tech Stack:** Postgres (SECURITY DEFINER + plpgsql), Supabase MCP `apply_migration` + `get_advisors`, Vitest, postgres.js client, `@supabase/supabase-js` admin client.

**Issue numbering:** Numbers in commit messages reference the table built in the original PR-D scoping turn (post-push backlog rows + post-chat-1 backlog rows + GitHub issue numbers when applicable). Cross-reference:
- #10 → post-push B2 (onboarding atomic)
- #9  → post-push B1 (listUsers)
- #7  → post-chat-1 #4 (phone_number_id immutability)
- #15 → GH #15 (cross-tenant tool tests)
- #13 → GH #13 (escalated flag fidelity)

---

## File Structure

**Create:**
- `packages/db/migrations/0033_create_clinic_with_owner.sql` — atomic onboarding RPC
- `packages/db/migrations/0034_clinic_integrations_immutable_clinic_id.sql` — trigger blocking `clinic_id` mutation
- `packages/db/tests/rls/create-clinic-with-owner.test.ts` — RPC integration test
- `packages/db/tests/rls/clinic-integrations-immutable.test.ts` — trigger integration test

**Modify:**
- `apps/web/app/(auth)/onboarding/actions.ts` — replace dual-insert + manual cleanup with single RPC call
- `apps/web/tests/actions/onboarding-action.test.ts` — adjust mocks to RPC path
- `apps/web/app/[slug]/settings/members/actions.ts` — replace `listUsers()` full-fetch with paginated + email-filtered lookup
- `apps/web/tests/actions/members-action.test.ts` (create if missing) — covers email lookup path
- `packages/integrations/whatsapp/kapso/src/adapter.ts:115-119` — add `.eq('clinic_id', ctx.clinicId)` to phone_number_id UPDATE
- `packages/integrations/whatsapp/kapso/tests/adapter.test.ts` — assert clinic_id filter in chain
- `packages/db/tests/rls/cross-tenant-ai.test.ts` — append `describe('collect_info_atomic cross-tenant defense')`
- `packages/ai/tests/tools/business-hours.test.ts` — append cross-tenant rejection test (unit, mock-based)
- `packages/ai/src/dispatcher.ts:489-512` — replace `escalatedByStepShape` (call-attempt detection) with `escalatedByToolResult` (success detection)
- `packages/ai/tests/dispatcher.test.ts` — add test covering escalated=false when tool returns `ok:false` (already-escalated case)

---

## Task 1 — Issue #10: `create_clinic_with_owner` atomic RPC

**Files:**
- Create: `packages/db/migrations/0033_create_clinic_with_owner.sql`
- Create: `packages/db/tests/rls/create-clinic-with-owner.test.ts`
- Modify: `apps/web/app/(auth)/onboarding/actions.ts`
- Modify: `apps/web/tests/actions/onboarding-action.test.ts`

### Step 1.1 — Write failing DB integration test

Create `packages/db/tests/rls/create-clinic-with-owner.test.ts`:

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { getServiceClient, createTestUser, deleteTestUser } from './helpers/setup.js';

const sql = getServiceClient();
const createdUserIds: string[] = [];
const createdClinicIds: string[] = [];

afterAll(async () => {
  if (createdClinicIds.length > 0) {
    await sql`DELETE FROM clinics WHERE id = ANY(${createdClinicIds}::uuid[])`;
  }
  await Promise.all(createdUserIds.map((id) => deleteTestUser(sql, id)));
  await sql.end();
});

describe('create_clinic_with_owner RPC (PR-D #10)', () => {
  it('cria clinic + clinic_members(owner) em transação única', async () => {
    const user = await createTestUser(sql);
    createdUserIds.push(user.id);
    const slug = `pr-d-rpc-${Date.now()}`;

    const [row] = await sql<{ id: string; slug: string }[]>`
      SELECT * FROM create_clinic_with_owner(
        ${'Clínica RPC Test'}::text,
        ${slug}::text,
        ${user.id}::uuid
      )
    `;
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row?.slug).toBe(slug);
    if (row?.id) createdClinicIds.push(row.id);

    const memberRows = await sql<{ role: string }[]>`
      SELECT role FROM clinic_members
      WHERE clinic_id = ${row!.id} AND user_id = ${user.id}
    `;
    expect(memberRows[0]?.role).toBe('owner');
  });

  it('rejeita slug duplicado via SQLSTATE 23505 e não deixa clinic órfã', async () => {
    const user = await createTestUser(sql);
    createdUserIds.push(user.id);
    const slug = `pr-d-dup-${Date.now()}`;
    // Pré-popula slug
    const [first] = await sql<{ id: string }[]>`
      SELECT id FROM create_clinic_with_owner(${'First'}::text, ${slug}::text, ${user.id}::uuid)
    `;
    createdClinicIds.push(first!.id);

    await expect(sql`
      SELECT create_clinic_with_owner(${'Second'}::text, ${slug}::text, ${user.id}::uuid)
    `).rejects.toThrow(/duplicate key|already exists|unique/i);

    const count = await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM clinics WHERE slug = ${slug}`;
    expect(count[0]?.c).toBe('1');
  });

  it('rejeita user_id inexistente (FK violation), sem clinic órfã', async () => {
    const fakeUserId = '00000000-0000-0000-0000-000000000099';
    const slug = `pr-d-nouser-${Date.now()}`;

    await expect(sql`
      SELECT create_clinic_with_owner(${'NoUser'}::text, ${slug}::text, ${fakeUserId}::uuid)
    `).rejects.toThrow(/foreign key|violates/i);

    const count = await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM clinics WHERE slug = ${slug}`;
    expect(count[0]?.c).toBe('0');
  });

  it('REVOKE de PUBLIC/anon/authenticated — só service_role executa', async () => {
    const rows = await sql<{ grantee: string; privilege_type: string }[]>`
      SELECT grantee, privilege_type FROM information_schema.routine_privileges
      WHERE routine_name = 'create_clinic_with_owner' AND routine_schema = 'public'
    `;
    const grantees = new Set(rows.map((r) => r.grantee));
    expect(grantees.has('service_role')).toBe(true);
    expect(grantees.has('anon')).toBe(false);
    expect(grantees.has('authenticated')).toBe(false);
  });
});
```

### Step 1.2 — Verify RED

Run: `pnpm --filter @medina/db test -- create-clinic-with-owner.test.ts`
Expected: FAIL — function `create_clinic_with_owner` does not exist (42883).

### Step 1.3 — Create migration 0033

Create `packages/db/migrations/0033_create_clinic_with_owner.sql`:

```sql
-- 0033_create_clinic_with_owner.sql
--
-- Issue PR-D #10 (post-push B2): onboarding atomicidade.
-- Antes: action fazia INSERT clinics então INSERT clinic_members(owner)
-- em duas chamadas separadas + cleanup manual (delete clinic) se o segundo
-- falhasse. Window de inconsistência se o processo morresse entre os dois
-- inserts ou se o cleanup falhasse.
--
-- Solução: RPC SECURITY DEFINER atômica. clinic + member num só BEGIN/COMMIT.
-- Falha em qualquer passo → ROLLBACK automático, nenhuma clinic órfã.
--
-- Service_role only: chamada exclusivamente por createClinicAction
-- (server-side com admin client). Não expor via REST público.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_clinic_with_owner(
  p_name    text,
  p_slug    text,
  p_user_id uuid
)
RETURNS TABLE (id uuid, slug text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_clinic_id uuid;
BEGIN
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'p_name must be non-empty';
  END IF;
  IF p_slug IS NULL OR length(trim(p_slug)) = 0 THEN
    RAISE EXCEPTION 'p_slug must be non-empty';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id must not be null';
  END IF;

  INSERT INTO public.clinics (name, slug)
  VALUES (p_name, p_slug)
  RETURNING clinics.id INTO v_clinic_id;

  INSERT INTO public.clinic_members (clinic_id, user_id, role)
  VALUES (v_clinic_id, p_user_id, 'owner');

  RETURN QUERY SELECT v_clinic_id, p_slug;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_clinic_with_owner(text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_clinic_with_owner(text, text, uuid)
  TO service_role;
```

### Step 1.4 — Apply migration via Supabase MCP

Call `mcp__plugin_supabase_supabase__apply_migration` with project_id=`vgdbpwdewoahvyqyaziv`, name=`0033_create_clinic_with_owner`, query=contents of the file.

### Step 1.5 — Verify GREEN + advisors clean

Run: `pnpm --filter @medina/db test -- create-clinic-with-owner.test.ts`
Expected: PASS, all 4 tests green.

Then call `mcp__plugin_supabase_supabase__get_advisors` type=security and type=performance. Expected: zero NEW warnings introduced by this migration.

### Step 1.6 — Modify onboarding action test (RED for refactor)

Replace `apps/web/tests/actions/onboarding-action.test.ts` admin mock to use RPC. The admin client now needs `rpc()` instead of `from('clinics').insert(...)`/`from('clinic_members').insert(...)`. Tests must:
- Cover RPC error path (slug duplicado mapeado para `'Este slug já está em uso.'`)
- Cover RPC success path (calls `redirect(\`/${slug}\`)`)
- Cover RPC generic error
- **Remove** tests that asserted manual cleanup (`clinicDeleteFn`) — no longer needed

Add a fresh `buildAdmin(rpcResult)` helper returning `{ rpc: vi.fn().mockResolvedValue(rpcResult) }`. Replace each `buildAdmin(clinicResult, memberResult)` call accordingly.

### Step 1.7 — Verify RED for action

Run: `pnpm --filter @medina/web test -- onboarding-action`
Expected: FAIL — current action calls `.from('clinics').insert(...)` not `.rpc(...)`.

### Step 1.8 — Refactor onboarding action (GREEN)

Replace body of `createClinicAction` in `apps/web/app/(auth)/onboarding/actions.ts` after auth check:

```typescript
  const admin = getSupabaseAdminClient()

  const { data, error } = await admin.rpc('create_clinic_with_owner', {
    p_name: result.data.name,
    p_slug: result.data.slug,
    p_user_id: user.id,
  })

  if (error) {
    if (error.code === '23505') {
      return { error: 'Este slug já está em uso. Escolha outro.' }
    }
    return { error: 'Erro ao criar clínica. Tente novamente.' }
  }

  const row = (Array.isArray(data) ? data[0] : data) as { id: string; slug: string } | null
  if (!row) {
    return { error: 'Erro ao criar clínica. Tente novamente.' }
  }

  revalidatePath('/', 'layout')
  redirect(`/${row.slug}`)
```

### Step 1.9 — Verify GREEN

Run: `pnpm --filter @medina/web test -- onboarding-action` → PASS.
Run: `pnpm --filter @medina/db test -- create-clinic-with-owner.test.ts` → still PASS.

### Step 1.10 — Commit

```bash
git add packages/db/migrations/0033_create_clinic_with_owner.sql \
        packages/db/tests/rls/create-clinic-with-owner.test.ts \
        apps/web/app/\(auth\)/onboarding/actions.ts \
        apps/web/tests/actions/onboarding-action.test.ts
git commit -m "fix(onboarding): atomic create_clinic_with_owner RPC (#10)"
```

---

## Task 2 — Issue #9: `listUsers()` paginação/email-filter

**Files:**
- Modify: `apps/web/app/[slug]/settings/members/actions.ts:31`
- Create/Modify: `apps/web/tests/actions/members-action.test.ts`

**Approach:** Supabase admin SDK não tem método público de filter-by-email direto, mas suporta paginação `listUsers({ page, perPage })`. Para grandes clinics isso não escala. A melhor opção é uma RPC SECURITY DEFINER que faz `SELECT id FROM auth.users WHERE email = $1 AND deleted_at IS NULL` direto.

Justificativa: `auth.users` é tabela protegida; só service_role acessa. RPC encapsula o pattern com lookup O(1) via índice email.

### Step 2.1 — Failing test for inviteMemberAction (uses RPC)

Modify or create `apps/web/tests/actions/members-action.test.ts`. Adicione um teste que verifica:
- inviteMemberAction chama `admin.rpc('get_user_id_by_email_internal', { p_email })` em vez de `auth.admin.listUsers()`
- Quando RPC retorna `null`, action retorna `'Usuário ainda não tem conta no Medina. …'`
- Quando RPC retorna `{ id }`, action insere em `clinic_members`

Test skeleton:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@medina/auth', () => ({
  getTenantContext: vi.fn(),
  getSupabaseServerClient: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  hasPermission: () => true,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { getTenantContext, getSupabaseAdminClient, getSupabaseServerClient } from '@medina/auth'
import { inviteMemberAction } from '../../app/[slug]/settings/members/actions'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getTenantContext).mockResolvedValue({
    clinicId: 'clinic-A',
    clinicSlug: 'clinic-a',
    user: { id: 'user-admin' },
    role: 'admin',
  } as unknown as Awaited<ReturnType<typeof getTenantContext>>)
})

describe('inviteMemberAction (PR-D #9: email-filter via RPC)', () => {
  it('chama RPC get_user_id_by_email_internal com email (não lista todos os users)', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'user-target', error: null })
    vi.mocked(getSupabaseAdminClient).mockReturnValue({ rpc } as never)
    const serverInsert = vi.fn().mockResolvedValue({ error: null })
    vi.mocked(getSupabaseServerClient).mockResolvedValue({
      from: () => ({ insert: serverInsert }),
    } as never)

    const result = await inviteMemberAction({ email: 'novo@x.com', role: 'member' })

    expect(rpc).toHaveBeenCalledWith('get_user_id_by_email_internal', { p_email: 'novo@x.com' })
    expect(result).toEqual({ success: true })
  })

  it('quando RPC retorna null → erro user-not-found, sem insert', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    vi.mocked(getSupabaseAdminClient).mockReturnValue({ rpc } as never)

    const result = await inviteMemberAction({ email: 'desconhecido@x.com', role: 'member' })

    expect(result.error).toMatch(/ainda não tem conta/)
  })
})
```

### Step 2.2 — Verify RED

Run: `pnpm --filter @medina/web test -- members-action` → FAIL (`rpc` is `undefined` because action still uses `auth.admin.listUsers()`).

### Step 2.3 — Add RPC `get_user_id_by_email_internal` (parte da mesma migration ou nova)

**Decisão:** anexa ao 0033 — semanticamente é parte do mesmo "onboarding & member admin internals". Renomeia migration para `0033_onboarding_and_member_internals.sql` (file move).

Append to migration 0033:

```sql
-- ─── PR-D #9: email→user_id lookup (replaces auth.admin.listUsers paginate) ───
CREATE OR REPLACE FUNCTION public.get_user_id_by_email_internal(p_email text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = auth, public, pg_catalog, pg_temp AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF p_email IS NULL OR length(trim(p_email)) = 0 THEN
    RAISE EXCEPTION 'p_email must be non-empty';
  END IF;

  SELECT id INTO v_user_id
  FROM auth.users
  WHERE email = lower(trim(p_email))
    AND deleted_at IS NULL
  LIMIT 1;

  RETURN v_user_id; -- NULL se não encontrado
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_user_id_by_email_internal(text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_user_id_by_email_internal(text)
  TO service_role;
```

Re-apply migration via MCP (`apply_migration` with new content). Note: Supabase MCP re-applies idempotently using `CREATE OR REPLACE`.

### Step 2.4 — Refactor `inviteMemberAction` (GREEN)

Replace lines 30-35 of `apps/web/app/[slug]/settings/members/actions.ts`:

```typescript
  const adminClient = getSupabaseAdminClient()
  const { data: targetUserId, error: lookupErr } = await adminClient.rpc(
    'get_user_id_by_email_internal',
    { p_email: parsed.data.email },
  )
  if (lookupErr) {
    return { error: 'Erro ao buscar usuário. Tente novamente.' }
  }
  if (!targetUserId) {
    return { error: 'Usuário ainda não tem conta no Medina. Peça pra ele criar conta primeiro.' }
  }
```

Then change `target.id` → `targetUserId as string` in the insert payload.

### Step 2.5 — Verify GREEN + advisors clean

Run: `pnpm --filter @medina/web test -- members-action` → PASS.
Run advisors via MCP.

### Step 2.6 — Commit

```bash
git add packages/db/migrations/0033_create_clinic_with_owner.sql \
        apps/web/app/\[slug\]/settings/members/actions.ts \
        apps/web/tests/actions/members-action.test.ts
git commit -m "fix(members): replace listUsers full-fetch with email-filter RPC (#9)"
```

---

## Task 3 — Issue #7: `phone_number_id` UPDATE clinic_id guard (defesa em profundidade)

**Files:**
- Create: `packages/db/migrations/0034_clinic_integrations_immutable_clinic_id.sql`
- Create: `packages/db/tests/rls/clinic-integrations-immutable.test.ts`
- Modify: `packages/integrations/whatsapp/kapso/src/adapter.ts:115-119`
- Modify: `packages/integrations/whatsapp/kapso/tests/adapter.test.ts`

### Step 3.1 — Failing trigger test

Create `packages/db/tests/rls/clinic-integrations-immutable.test.ts`:

```typescript
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  getServiceClient, createTestClinic, createTestIntegration,
  deleteTestClinic, ensureVaultMasterKey,
} from './helpers/setup.js';

const sql = getServiceClient();
const createdClinics: string[] = [];

beforeAll(async () => {
  await ensureVaultMasterKey(sql);
});

afterAll(async () => {
  await Promise.all(createdClinics.map((id) => deleteTestClinic(sql, id)));
  await sql.end();
});

describe('clinic_integrations.clinic_id immutability (PR-D #7)', () => {
  it('UPDATE alterando clinic_id raises exception, mesmo via service_role', async () => {
    const a = await createTestClinic(sql, 'Immut-A'); createdClinics.push(a.id);
    const b = await createTestClinic(sql, 'Immut-B'); createdClinics.push(b.id);
    const intA = await createTestIntegration(sql, a.id);

    await expect(sql`
      UPDATE clinic_integrations SET clinic_id = ${b.id} WHERE id = ${intA.id}
    `).rejects.toThrow(/clinic_id is immutable|cannot change clinic_id/i);

    const [row] = await sql<{ clinic_id: string }[]>`
      SELECT clinic_id FROM clinic_integrations WHERE id = ${intA.id}
    `;
    expect(row?.clinic_id).toBe(a.id);
  });

  it('UPDATE mantendo clinic_id igual ao OLD passa (no-op para config update)', async () => {
    const a = await createTestClinic(sql, 'Immut-C'); createdClinics.push(a.id);
    const intA = await createTestIntegration(sql, a.id);

    await sql`
      UPDATE clinic_integrations
      SET config = jsonb_set(config, '{phone_number_id}', '"123"'::jsonb),
          clinic_id = ${a.id}
      WHERE id = ${intA.id}
    `;
    const [row] = await sql<{ config: Record<string, unknown> }[]>`
      SELECT config FROM clinic_integrations WHERE id = ${intA.id}
    `;
    expect((row?.config as { phone_number_id?: string })?.phone_number_id).toBe('123');
  });

  it('UPDATE sem mexer em clinic_id passa (config-only update)', async () => {
    const a = await createTestClinic(sql, 'Immut-D'); createdClinics.push(a.id);
    const intA = await createTestIntegration(sql, a.id);

    await sql`
      UPDATE clinic_integrations
      SET config = '{"phone_number_id":"456"}'::jsonb
      WHERE id = ${intA.id}
    `;
    const [row] = await sql<{ config: Record<string, unknown> }[]>`
      SELECT config FROM clinic_integrations WHERE id = ${intA.id}
    `;
    expect((row?.config as { phone_number_id?: string })?.phone_number_id).toBe('456');
  });
});
```

### Step 3.2 — Verify RED

Run: `pnpm --filter @medina/db test -- clinic-integrations-immutable.test.ts`
Expected: FAIL — first test passes (no trigger) where it should raise.

### Step 3.3 — Create migration 0034

```sql
-- 0034_clinic_integrations_immutable_clinic_id.sql
--
-- Issue PR-D #7 (post-chat-1 backlog #4): defesa em profundidade no UPDATE
-- de clinic_integrations. App-level já adicionou .eq('clinic_id', ctx.clinicId)
-- no UPDATE da Kapso adapter, mas defense-in-depth pede uma barreira DB-level
-- que impeça qualquer caller (incluindo service_role) de mutar clinic_id de
-- uma integration existente.
--
-- Decisão: trigger BEFORE UPDATE que rejeita se NEW.clinic_id IS DISTINCT FROM
-- OLD.clinic_id. clinic_id de uma integration é parte da identidade — recriar
-- é a forma correta de "mover" entre clinics (improvável, mas explícito).
--
-- BEFORE (não AFTER) porque pode abortar a operação antes de qualquer side
-- effect (audit trigger AFTER UPDATE em outras tabelas continua intacto).
-- SECURITY DEFINER não é necessário: trigger executa no contexto da operação.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.enforce_clinic_integrations_clinic_id_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id THEN
    RAISE EXCEPTION 'clinic_integrations.clinic_id is immutable: cannot change from % to %',
      OLD.clinic_id, NEW.clinic_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clinic_integrations_immutable_clinic_id
  ON public.clinic_integrations;

CREATE TRIGGER trg_clinic_integrations_immutable_clinic_id
  BEFORE UPDATE ON public.clinic_integrations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_clinic_integrations_clinic_id_immutable();

-- Trigger function never called directly via REST.
REVOKE EXECUTE ON FUNCTION public.enforce_clinic_integrations_clinic_id_immutable()
  FROM PUBLIC, anon, authenticated;
```

### Step 3.4 — Apply migration via MCP + verify GREEN + advisors

```
mcp.apply_migration(project_id, '0034_clinic_integrations_immutable_clinic_id', query=…)
```

Run: `pnpm --filter @medina/db test -- clinic-integrations-immutable.test.ts` → PASS (3 tests).
Run advisors → expect no new warnings.

### Step 3.5 — Failing adapter test (`.eq('clinic_id', ...)` chain)

Modify `packages/integrations/whatsapp/kapso/tests/adapter.test.ts`. Find the `captures phone_number_id into integration.config when missing` test (around line 318). The current mock probably doesn't track `.eq()` calls precisely. Add or modify a test that verifies BOTH `.eq('id', ...)` AND `.eq('clinic_id', ...)` are invoked. Expected new test:

```typescript
it('UPDATE phone_number_id includes clinic_id .eq filter (defense in depth)', async () => {
  const updateEq1 = vi.fn().mockReturnThis();
  const updateEq2 = vi.fn().mockResolvedValue({ error: null });
  const updateFn = vi.fn().mockReturnValue({ eq: updateEq1.mockReturnValue({ eq: updateEq2 }) });
  // …assemble sb mock such that from('clinic_integrations').update(...).eq(...).eq(...)
  // is the path used in adapter.

  await handle(/* inbound with new phoneNumberId */, ctxWithClinicId('clinic-A'));

  // First .eq is id, second .eq is clinic_id (or vice versa — assert both keys present)
  const eqArgs = [...updateEq1.mock.calls.flat(), ...updateEq2.mock.calls.flat()];
  expect(eqArgs).toContain('id');
  expect(eqArgs).toContain('clinic_id');
  expect(eqArgs).toContain('clinic-A');
});
```

(The exact mock shape depends on the adapter test's existing harness. The key assertion is presence of both filter keys + the clinic-A scope. See existing `captures phone_number_id` test for setup pattern.)

### Step 3.6 — Verify RED

Run: `pnpm --filter @medina/integrations-whatsapp-kapso test -- adapter` → FAIL (current code calls `.update(...).eq('id', ...)` only — no `.eq('clinic_id', ...)`).

### Step 3.7 — Add `.eq('clinic_id', ...)` to adapter (GREEN)

In `packages/integrations/whatsapp/kapso/src/adapter.ts:115-119`:

```typescript
  if (cfg['phone_number_id'] !== inbound.phoneNumberId) {
    await sb
      .from('clinic_integrations')
      .update({ config: { ...cfg, phone_number_id: inbound.phoneNumberId } })
      .eq('id', ctx.integration.id)
      .eq('clinic_id', ctx.clinicId);
  }
```

### Step 3.8 — Verify GREEN

Run: `pnpm --filter @medina/integrations-whatsapp-kapso test -- adapter` → PASS.
Run: `pnpm --filter @medina/db test -- clinic-integrations-immutable.test.ts` → still PASS.

### Step 3.9 — Commit

```bash
git add packages/db/migrations/0034_clinic_integrations_immutable_clinic_id.sql \
        packages/db/tests/rls/clinic-integrations-immutable.test.ts \
        packages/integrations/whatsapp/kapso/src/adapter.ts \
        packages/integrations/whatsapp/kapso/tests/adapter.test.ts
git commit -m "fix(integrations): clinic_id immutable + .eq guard on phone_number_id UPDATE (#7)"
```

---

## Task 4 — Issue #15: Cross-tenant tests collect_info + business_hours

**Files:**
- Modify: `packages/db/tests/rls/cross-tenant-ai.test.ts` — append new describe
- Modify: `packages/ai/tests/tools/business-hours.test.ts` — append unit test

### Step 4.1 — Add failing DB integration test for collect_info_atomic cross-tenant

Append to `packages/db/tests/rls/cross-tenant-ai.test.ts` (inside `describe('cross-tenant defense in depth (PR-A #15)', () => {`):

```typescript
  it('collect_info_atomic rejects when p_clinic_id != conv.clinic_id (PR-D #15)', async () => {
    const clinicA = await makeClinic('CI-A');
    const clinicB = await makeClinic('CI-B');
    const intA = await createTestIntegration(sql, clinicA.id);
    const convA = await createTestConversation(sql, clinicA.id, intA.id);

    await expect(sql`
      SELECT collect_info_atomic(
        ${convA.id}::uuid, ${clinicB.id}::uuid, 'name'::text, '2026-05-12T00:00:00Z'::text
      )
    `).rejects.toThrow(/cross-tenant violation/);

    // Sanity: convA.metadata unchanged (no partial write).
    const [row] = await sql<{ metadata: Record<string, unknown> | null }[]>`
      SELECT metadata FROM conversations WHERE id = ${convA.id}
    `;
    const collected = (row?.metadata as { collected_info?: Record<string, unknown> } | null)?.collected_info;
    expect(collected).toBeUndefined();
  });
```

### Step 4.2 — Verify it passes immediately (RPC already enforces — this is regression-coverage)

Run: `pnpm --filter @medina/db test -- cross-tenant-ai` → PASS for the new test.

**Note:** This test passes immediately because the RPC's cross-tenant guard already exists in migration 0023. The TDD intent here is regression-coverage — locks in current behavior so any future migration that weakens the guard fails the test. Document the intent in a comment above the test.

### Step 4.3 — Add failing unit test for business_hours cross-tenant rejection

Append to `packages/ai/tests/tools/business-hours.test.ts`:

```typescript
  it('rejects when supabase returns clinic with id != ctx.clinicId (cross-tenant defense, PR-D #15)', async () => {
    vi.setSystemTime(new Date('2026-05-06T13:00:00Z'));
    const mock = buildMockSupabase({
      clinics: { single: { id: 'clinic-OTHER', business_hours: SCHEDULE_DEFAULT } },
    });
    await expect(
      asTool(buildBusinessHoursTool(buildToolContext({ supabase: mock.supabase as never })))
        .execute({}),
    ).rejects.toThrow(/cross-tenant violation/);
  });
```

### Step 4.4 — Verify GREEN

Run: `pnpm --filter @medina/ai test -- business-hours` → PASS (the tool already has the `clinic.id !== clinicId` guard at line 58-60; this test locks it in as regression coverage).

### Step 4.5 — Commit

```bash
git add packages/db/tests/rls/cross-tenant-ai.test.ts \
        packages/ai/tests/tools/business-hours.test.ts
git commit -m "test(ai): explicit cross-tenant rejection tests for collect_info + business_hours (#15)"
```

---

## Task 5 — Issue #13: `escalated` flag reflete sucesso da tool

**Files:**
- Modify: `packages/ai/src/dispatcher.ts:489-512`
- Modify: `packages/ai/tests/dispatcher.test.ts`

### Background

Current code (`dispatcher.ts:500-512`):

```typescript
const escalatedByStepShape = steps.some((s) =>
  (s.toolCalls ?? []).some((tc) => tc.payload?.toolName === 'escalate_to_human'),
)
let escalated = escalatedByStepShape
if (!escalated) {
  // state-based fallback
}
```

**Bug:** `escalatedByStepShape` é true sempre que o LLM CHAMOU `escalate_to_human` — independente de a RPC ter tido sucesso. Quando a tool retorna `{ ok: false }` (conversa já em waiting_human), o `escalated` ainda vira true via shape.

**Fix:** Inspecionar `step.toolResults[].payload.result.ok === true` em vez do call mero. Mantém state-based fallback como segundo sinal.

### Step 5.1 — Failing test

Add to `packages/ai/tests/dispatcher.test.ts`:

```typescript
import type { AgentStep } from '../src/dispatcher.js' // ou shape relevante

it('didEscalate=false quando escalate_to_human retorna { ok: false } (#13)', async () => {
  // Setup: mock LLM result com 1 toolCall E 1 toolResult onde result.ok=false.
  // Mock supabase para retornar state ainda='ai_handling' (escalate falhou pre-rpc
  // ou foi already-escalated). Esperar didEscalate=false.
  // [exact test wiring depends on existing dispatcher.test.ts helpers]
});

it('didEscalate=true quando escalate_to_human retorna { ok: true } (#13)', async () => {
  // Mesma estrutura mas result.ok=true. state transiciona pra waiting_human.
  // Esperar didEscalate=true.
});
```

(Detailed test code is filled in during execution after reading current `dispatcher.test.ts` structure.)

### Step 5.2 — Verify RED

Run: `pnpm --filter @medina/ai test -- dispatcher` → FAIL — `escalated` é true porque shape detecta call mesmo com ok:false.

### Step 5.3 — Fix dispatcher (GREEN)

Replace lines 499-512 of `packages/ai/src/dispatcher.ts`:

```typescript
      // 6. Detect tool-call escalation. PR-D #13 fix: check toolResult.ok=true,
      //    not bare toolCall presence — call attempts where the RPC returned
      //    ok:false (already-escalated, race) must NOT set didEscalate=true.
      const steps = ((result as { steps?: AgentStep[] }).steps) ?? []
      const escalatedByToolResult = steps.some((s) =>
        (s.toolResults ?? []).some((tr) => {
          const isEscalateTool = tr.payload?.toolName === 'escalate_to_human'
          const ok = (tr.payload?.result as { ok?: boolean } | undefined)?.ok === true
          return isEscalateTool && ok
        }),
      )
      let escalated = escalatedByToolResult
      if (!escalated) {
        // State-based fallback: if dispatcher started in ai_handling and we
        // now find waiting_human/resolved, escalation happened this turn (via
        // guardrail path or tool path where shape changed across Mastra
        // versions). Reading state both before and after the LLM run is
        // overkill — dispatcher only runs when conv is ai_handling on entry.
        const { data: convAfter } = await supabase
          .from('conversations')
          .select('state')
          .eq('id', conversationId)
          .single()
        const stateAfter = (convAfter as { state?: string } | null)?.state
        escalated = stateAfter === 'waiting_human' || stateAfter === 'resolved'
      }
```

Also confirm/update `AgentStep` type in `dispatcher.ts` (or wherever defined) to include `toolResults` if not present.

### Step 5.4 — Verify GREEN

Run: `pnpm --filter @medina/ai test -- dispatcher` → PASS for new tests + existing tests still PASS.

### Step 5.5 — Commit

```bash
git add packages/ai/src/dispatcher.ts packages/ai/tests/dispatcher.test.ts
git commit -m "fix(ai): escalated flag reflects tool success not call attempt (#13)"
```

---

## Task 6 — Final verification + PR

### Step 6.1 — Full suite

```bash
pnpm test
pnpm typecheck
pnpm build
```

All green required. If any iclinic typecheck noise persists (pre-existing per memory), exclude from blocking but flag in PR body.

### Step 6.2 — Final advisor check via MCP

`get_advisors` for both security and performance. Compare against baseline (no new warnings introduced).

### Step 6.3 — Open PR (no merge)

```bash
git push -u origin g/pr-d-security-tenancy
gh pr create --base main --title "fix: PR-D security & tenancy backlog (#10 #9 #7 #15 #13)" \
  --body "$(cat <<'EOF'
## Summary
- **#10** atomic `create_clinic_with_owner` RPC — eliminates orphan-clinic window in onboarding
- **#9** replace `auth.admin.listUsers()` full-fetch with `get_user_id_by_email_internal` RPC (O(1) email lookup)
- **#7** `clinic_id` immutability trigger on `clinic_integrations` + `.eq('clinic_id', ...)` guard in Kapso adapter UPDATE
- **#15** explicit cross-tenant rejection tests for `collect_info_atomic` + `check_business_hours`
- **#13** `didEscalate` reflects tool result `ok:true`, not bare call attempt

Originally scoped 5 issues. Issue #13 from PR-D scope (RLS conversations `auth.uid()` wrap) was dropped as STALE — already fixed by migration 0006_chat_rls_fix. Live DB confirms wrap present. Replaced by GH #13 (escalated flag fidelity).

## Test plan
- [x] DB integration tests: `pnpm --filter @medina/db test`
- [x] Web action tests: `pnpm --filter @medina/web test`
- [x] AI tool/dispatcher tests: `pnpm --filter @medina/ai test`
- [x] Kapso adapter tests: `pnpm --filter @medina/integrations-whatsapp-kapso test`
- [x] Typecheck: `pnpm typecheck`
- [x] Build: `pnpm build`
- [x] Supabase advisors: zero new warnings (security + performance)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Do **NOT** merge. Report PR URL.

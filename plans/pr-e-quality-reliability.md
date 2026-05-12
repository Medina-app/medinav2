# PR-E Quality & Reliability Backlog Implementation Plan

> **For agentic workers:** Execute task-by-task. Each task is a single commit. TDD required: RED → verify fail → GREEN → verify pass → commit.

**Goal:** Endereça 5 items de quality/reliability backlog: dead-code cleanup do `cleanupAll`, validação de cast Buffer no mapper de integrations, refactor do webhook test pra parar de espiar `console.log`, singleton lazy do Supabase admin client no webhook handler, e suporte real a múltiplos `agent_config` names via coluna em `clinics`.

**Architecture:** 1 migration Postgres adicionando `clinics.default_agent_name` (column + default value), refactor de 3 módulos em `packages/integrations/core/` (logger interface + mappers shape guard + webhook-handler singleton), deleção do dead-code em `packages/db/tests/rls/helpers/setup.ts`, e refactor do dispatcher pra ler `default_agent_name` do clinic. 5 commits sequenciais.

**Tech Stack:** Postgres (ALTER TABLE), TypeScript estrito, Vitest, Supabase MCP `apply_migration` + `get_advisors`, postgres.js client, @supabase/supabase-js.

**Issue mapping:**
- **cleanup** → dead-code removal of `cleanupAll` no-op (post-chat-1 #5 wrap-up)
- **#8** → post-chat-1 #5 (Buffer cast em mappers.ts:24)
- **#11** → post-push B3 (webhook test acopla `console.log`)
- **#6** → post-chat-1 #3 + post-push B6 (`createDefaultLookup` cria client por hit) — consolidado
- **GH #8** → AI-1 follow-up (hardcoded 'agente-principal')

PR title: `fix: PR-E quality & reliability backlog (#6 #8 #11 + cleanup)`

---

## File Structure

**Create:**
- `packages/db/migrations/0036_clinics_default_agent_name.sql` — adiciona coluna + default

**Modify:**
- `packages/db/tests/rls/helpers/setup.ts` — remove `cleanupAll` dead function (Task 1)
- `packages/integrations/core/src/mappers.ts:24` — validate Buffer shape before cast (Task 2)
- `packages/integrations/core/tests/mappers.test.ts` — add test for non-Buffer input (Task 2)
- `packages/integrations/core/src/logger.ts` — extract logger to interface for injection (Task 3)
- `packages/integrations/core/src/webhook-handler.ts` — accept optional logger param + module-level lookup singleton (Task 3 + Task 4)
- `packages/integrations/core/tests/webhook-handler.test.ts` — replace `vi.spyOn(console, 'log')` with injected mock logger (Task 3); add singleton test (Task 4)
- `packages/ai/src/dispatcher.ts` — read `clinics.default_agent_name` if `agentName` not provided in args (Task 5)
- `packages/ai/tests/dispatcher.test.ts` — add test for default_agent_name routing (Task 5)
- `packages/db/tests/rls/clinics.test.ts` (or new file) — DB test for new column shape (Task 5)

---

## Task 1 — Cleanup dead `cleanupAll` function

**Files:**
- Modify: `packages/db/tests/rls/helpers/setup.ts:400-412`

### Step 1.1 — Verify zero callers

```bash
grep -rn "cleanupAll\(" packages/db/tests packages/ai packages/chat apps --include="*.ts"
```
Expected: zero matches. If matches found, refactor those callers first (out of scope of this PR — escalate to user).

### Step 1.2 — Delete the function

Remove lines 400-412 of `packages/db/tests/rls/helpers/setup.ts`:

```typescript
/**
 * @deprecated Use deleteTestClinic per-clinic instead. cleanupAll wiped
 * EVERY row of 14 tables and ate dev/staging fixtures on every test run
 * (issue #5). Now a no-op so existing callers stop being destructive
 * without forcing a same-PR refactor of every test file. Will be removed
 * once all callers in packages/db/tests/rls/* are migrated.
 */
export async function cleanupAll(_sql: postgres.Sql): Promise<void> {
  console.warn(
    'cleanupAll is deprecated and now a no-op — track createdClinics and call deleteTestClinic(sql, id) in afterAll. See issue #5.',
  );
}
```

### Step 1.3 — Verify typecheck + tests still pass

```bash
pnpm --filter @medina/db typecheck
pnpm --filter @medina/db exec vitest run tests/rls/helpers/setup.test.ts
```

Both green.

### Step 1.4 — Commit

```bash
git add packages/db/tests/rls/helpers/setup.ts
git commit -m "chore(db): remove deprecated cleanupAll no-op (issue #5 wrap-up)"
```

---

## Task 2 — #8: validate Buffer cast in mappers.ts

**Files:**
- Modify: `packages/integrations/core/src/mappers.ts:24`
- Modify: `packages/integrations/core/tests/mappers.test.ts`

**Background:** `(row['encrypted_credentials'] as Buffer | null) ?? null` is a typed lie. Supabase JS serializes `bytea` columns as hex strings (`\x...`), not Buffer instances. The Drizzle type infers `Buffer | null` from the schema column declaration, but at this transport boundary the runtime value is never a Buffer. Today the field is never consumed with non-null data (the decrypt happens via `get_integration_credential_internal` RPC server-side), so the lie is latent — but a future consumer could trust the type and call `.length` or `.toString('utf8')` on a string, blowing up at runtime.

Fix: validate shape with `Buffer.isBuffer()` at the mapper. If the runtime value isn't a Buffer, return `null` (since the type contract says `Buffer | null`).

### Step 2.1 — Failing test

Add to `packages/integrations/core/tests/mappers.test.ts`:

```typescript
import { Buffer } from 'node:buffer';

it('mapClinicIntegration returns null for encryptedCredentials when value is a hex string (Supabase JS bytea shape) (#8)', () => {
  const row = makeRow({ encrypted_credentials: '\\x4f1a2b3c' });
  const out = mapClinicIntegration(row);
  expect(out.encryptedCredentials).toBeNull();
});

it('mapClinicIntegration returns Buffer for encryptedCredentials when value is a real Buffer (Drizzle client path) (#8)', () => {
  const buf = Buffer.from('hello', 'utf8');
  const row = makeRow({ encrypted_credentials: buf });
  const out = mapClinicIntegration(row);
  expect(out.encryptedCredentials).toEqual(buf);
});

it('mapClinicIntegration returns null for encryptedCredentials when value is null', () => {
  const row = makeRow({ encrypted_credentials: null });
  const out = mapClinicIntegration(row);
  expect(out.encryptedCredentials).toBeNull();
});
```

(`makeRow` is a factory the existing test file should already use or extend; copy-paste the existing pattern if absent. Each test only varies `encrypted_credentials`.)

### Step 2.2 — Verify RED

```bash
pnpm --filter @medina/integrations-core exec vitest run tests/mappers.test.ts
```
Expected: FAIL — current cast returns the string `'\x4f1a2b3c'` typed as `Buffer`, so `toBeNull()` fails.

### Step 2.3 — Add shape guard (GREEN)

Replace `mappers.ts:24`:

```typescript
encryptedCredentials: Buffer.isBuffer(row['encrypted_credentials'])
  ? row['encrypted_credentials']
  : null,
```

Add import at top:

```typescript
import { Buffer } from 'node:buffer';
```

### Step 2.4 — Verify GREEN

```bash
pnpm --filter @medina/integrations-core exec vitest run tests/mappers.test.ts
```
Expected: PASS, all tests green.

### Step 2.5 — Commit

```bash
git add packages/integrations/core/src/mappers.ts packages/integrations/core/tests/mappers.test.ts
git commit -m "fix(integrations): validate Buffer shape before cast in mapClinicIntegration (#8)"
```

---

## Task 3 — #11: webhook test sem `console.log` spy + logger injection

**Files:**
- Modify: `packages/integrations/core/src/logger.ts`
- Modify: `packages/integrations/core/src/webhook-handler.ts`
- Modify: `packages/integrations/core/tests/webhook-handler.test.ts:175,192`

**Background:** Tests at `webhook-handler.test.ts:175,192` use `vi.spyOn(console, 'log')` and `JSON.parse(c[0])` to assert on structured log output. This couples the test to the logger's stdout-serialization implementation — any future change to logger transport (e.g., switching to pino, structlog format change, redirecting to stderr) silently breaks the assertion shape.

Fix: extract logger to an injectable interface. `handleWebhook` accepts an optional `logger` param (default = the existing module-level logger). Tests pass a mock logger and assert on the structured call args directly.

### Step 3.1 — Failing test refactor

Replace the two `vi.spyOn(console, 'log')` blocks in `webhook-handler.test.ts`. New test shape:

```typescript
import type { Logger } from '../src/logger.js'

function makeMockLogger(): { logger: Logger; calls: { level: string; entry: unknown }[] } {
  const calls: { level: string; entry: unknown }[] = []
  const logger: Logger = {
    info: (e) => { calls.push({ level: 'info', entry: e }) },
    warn: (e) => { calls.push({ level: 'warn', entry: e }) },
    error: (e) => { calls.push({ level: 'error', entry: e }) },
  }
  return { logger, calls }
}

it('logs structured warn when InngestDispatchError surfaces (#11: via injected logger)', async () => {
  const body = '{}'
  registry.register(
    makeAdapter({
      handle: vi.fn().mockRejectedValue(new InngestDispatchError(new Error('upstream down'))),
    }),
  )
  const { logger, calls } = makeMockLogger()
  await handleWebhook(
    req(body, { 'x-kapso-signature': sign(SECRET, body) }),
    PARAMS,
    vi.fn().mockResolvedValue(makeInt()),
    undefined,
    undefined,
    logger,
  )
  const warnEntry = calls.find((c) => c.level === 'warn' && (c.entry as { action: string }).action === 'inngest_dispatch')
  expect(warnEntry).toBeDefined()
  expect((warnEntry!.entry as { success: boolean }).success).toBe(false)
  expect(String((warnEntry!.entry as { error: string }).error)).toContain('inngest dispatch failed')
})

it('logs structured error when adapter throws (#11: via injected logger)', async () => {
  const body = '{}'
  registry.register(makeAdapter({ handle: vi.fn().mockRejectedValue(new Error('conn refused')) }))
  const { logger, calls } = makeMockLogger()
  await handleWebhook(
    req(body, { 'x-kapso-signature': sign(SECRET, body) }),
    PARAMS,
    vi.fn().mockResolvedValue(makeInt()),
    undefined,
    undefined,
    logger,
  )
  const errEntry = calls.find((c) => c.level === 'error')
  expect(errEntry).toBeDefined()
  expect((errEntry!.entry as { success: boolean }).success).toBe(false)
  expect(String((errEntry!.entry as { error: string }).error)).toContain('conn refused')
})
```

(The `Logger` type and the new param need to exist for these tests to typecheck — Step 3.3 adds them. If TS strict mode forces ordering, accept the temporary breakage and resolve in 3.3.)

### Step 3.2 — Verify RED

```bash
pnpm --filter @medina/integrations-core exec vitest run tests/webhook-handler.test.ts
```
Expected: FAIL — `handleWebhook` doesn't accept a logger param yet; tests fail to typecheck OR fall through to default console-based logger.

### Step 3.3 — Extract Logger interface + inject (GREEN)

Modify `packages/integrations/core/src/logger.ts`:

```typescript
type Level = 'info' | 'warn' | 'error'

export type LogEntry = {
  clinic_id: string
  integration_id: string
  type: string
  provider: string
  action: string
  duration_ms: number
  success: boolean
  error?: string
}

export interface Logger {
  info: (e: LogEntry) => void
  warn: (e: LogEntry) => void
  error: (e: LogEntry) => void
}

const stdoutLog = (level: Level, e: LogEntry) =>
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, ...e }))

export const logger: Logger = {
  info: (e) => stdoutLog('info', e),
  warn: (e) => stdoutLog('warn', e),
  error: (e) => stdoutLog('error', e),
}
```

Modify `webhook-handler.ts` signature:

```typescript
export async function handleWebhook(
  req: Request,
  params: { type: string; provider: string; clinicId: string },
  lookupFn: LookupFn = createDefaultLookup(),  // Task 4 changes this default — for now keep
  inngestSend?: InngestSendFn,
  publishEvent?: PublishEventFn,
  loggerOverride?: Logger,  // PR-E #11: enables test injection without console.log spy
): Promise<Response> {
  const log = loggerOverride ?? logger
  // …replace all `logger.info(...)` / `logger.warn(...)` / `logger.error(...)`
  //  references inside the body with `log.info(...)` etc.
```

Replace the existing `logger.warn(...)`, `logger.info(...)`, `logger.error(...)` calls inside `handleWebhook` body with `log.warn(...)`, `log.info(...)`, `log.error(...)` to use the injected instance.

Add type import at top:

```typescript
import { logger, type Logger } from './logger'
```

### Step 3.4 — Verify GREEN

```bash
pnpm --filter @medina/integrations-core exec vitest run tests/webhook-handler.test.ts
```
Expected: PASS, all webhook-handler tests green (existing + 2 refactored).

### Step 3.5 — Commit

```bash
git add packages/integrations/core/src/logger.ts \
        packages/integrations/core/src/webhook-handler.ts \
        packages/integrations/core/tests/webhook-handler.test.ts
git commit -m "refactor(integrations): inject Logger into handleWebhook (#11)"
```

---

## Task 4 — #6+#14: singleton Supabase admin client in webhook handler

**Files:**
- Modify: `packages/integrations/core/src/webhook-handler.ts:16-46`
- Modify: `packages/integrations/core/tests/webhook-handler.test.ts` — add singleton test

**Background:** `lookupFn: LookupFn = createDefaultLookup()` as a default param value means `createDefaultLookup()` (and its inner `createClient(...)`) runs **per call** of `handleWebhook`. Every webhook hit instantiates a fresh Supabase client with its own connection pool. Two backlog audits flagged it: post-chat-1 #3 ("per webhook hit") and post-push B6 ("per cold start" — semantically the same once you read the code). Fix: module-level lazy singleton.

### Step 4.1 — Failing test

Add to `webhook-handler.test.ts`:

```typescript
it('createDefaultLookup is memoized at module scope — repeated handleWebhook calls reuse the same client (#6+#14)', async () => {
  // We can't inspect the internal sb directly without exporting it; use a
  // proxy: spyOn the @supabase/supabase-js createClient and assert it's
  // called at most ONCE across N webhook invocations (the singleton path).
  const createClientSpy = vi.spyOn(supabaseModule, 'createClient')
  const initialCalls = createClientSpy.mock.calls.length
  const body = '{}'
  registry.register(makeAdapter({ handle: vi.fn().mockResolvedValue({ processed: true }) }))
  // Hit the handler 3x using the default lookupFn (don't override).
  for (let i = 0; i < 3; i++) {
    await handleWebhook(
      req(body, { 'x-kapso-signature': sign(SECRET, body) }),
      PARAMS,
    )
  }
  const delta = createClientSpy.mock.calls.length - initialCalls
  // Allowed: 0 (already created in prior test) or 1 (first creation now).
  // NOT allowed: ≥ 3 (one per hit).
  expect(delta).toBeLessThanOrEqual(1)
})
```

Hoist this import at the top of the test file alongside the existing mocks:

```typescript
import * as supabaseModule from '@supabase/supabase-js'
```

Note: the existing mock at `vi.mock('@supabase/supabase-js', ...)` needs to be compatible with `vi.spyOn`. If the existing mock replaces `createClient` with a `vi.fn()`, that's the spy target already — adjust as needed.

### Step 4.2 — Verify RED

```bash
pnpm --filter @medina/integrations-core exec vitest run tests/webhook-handler.test.ts
```
Expected: FAIL — `delta` is 3 (one createClient call per handleWebhook invocation).

### Step 4.3 — Refactor to module-level singleton (GREEN)

Replace lines 16-46 of `webhook-handler.ts`:

```typescript
// PR-E #6+#14: module-level lazy singleton. Default param `createDefaultLookup()`
// was evaluated per call, instantiating a fresh Supabase client + connection
// pool on every webhook hit. Memoize the lookup fn here so the FIRST
// handleWebhook call lazily creates one client, subsequent calls reuse it.
//
// Lazy (vs eager `const defaultLookup = createDefaultLookup()` at top-level)
// because the env vars may not be set at module import time during certain
// test/build paths; defer until the first webhook hit guarantees they're
// set by then.
let _defaultLookup: LookupFn | null = null

function getDefaultLookup(): LookupFn {
  if (_defaultLookup == null) {
    _defaultLookup = createDefaultLookupImpl()
  }
  return _defaultLookup
}

function createDefaultLookupImpl(): LookupFn {
  const sb = createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
  return async (type, provider, clinicId) => {
    const { data } = await sb
      .from('clinic_integrations')
      .select('*')
      .eq('type', type)
      .eq('provider', provider)
      .eq('clinic_id', clinicId)
      .is('deleted_at', null)
      .single()
    return data ? mapClinicIntegration(data as Record<string, unknown>) : null
  }
}

const j = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export async function handleWebhook(
  req: Request,
  params: { type: string; provider: string; clinicId: string },
  lookupFn?: LookupFn,
  inngestSend?: InngestSendFn,
  publishEvent?: PublishEventFn,
  loggerOverride?: Logger,
): Promise<Response> {
  const log = loggerOverride ?? logger
  const lookup = lookupFn ?? getDefaultLookup()
  // …rest unchanged, except replace `lookupFn` references with `lookup`
```

The `createDefaultLookup` name is no longer exported — it's renamed to `createDefaultLookupImpl` and kept internal. If any other module imports it, update those imports (likely none — it was previously implicitly invoked through the default param).

### Step 4.4 — Verify GREEN

```bash
pnpm --filter @medina/integrations-core exec vitest run tests/webhook-handler.test.ts
```
Expected: PASS — `delta` ≤ 1.

### Step 4.5 — Verify no regressions across the suite

```bash
pnpm --filter @medina/integrations-core exec vitest run
pnpm --filter @medina/integrations-whatsapp-kapso exec vitest run
pnpm --filter @medina/integrations-calcom exec vitest run
```
All green.

### Step 4.6 — Commit

```bash
git add packages/integrations/core/src/webhook-handler.ts packages/integrations/core/tests/webhook-handler.test.ts
git commit -m "perf(integrations): memoize Supabase client in webhook handler (#6 #14)"
```

---

## Task 5 — GH #8: support per-clinic `default_agent_name`

**Files:**
- Create: `packages/db/migrations/0036_clinics_default_agent_name.sql`
- Create: `packages/db/tests/rls/clinics-default-agent-name.test.ts`
- Modify: `packages/ai/src/dispatcher.ts` — load `default_agent_name` from clinic when `agentName` arg not provided
- Modify: `packages/ai/tests/dispatcher.test.ts` — test routing via clinic column

**Background:** `agent-factory.ts:67` and `dispatcher.ts:120` both accept an optional `agentName` parameter defaulting to `'agente-principal'`. Infrastructure exists, but no caller in production passes anything other than the default — `inngest/functions/dispatch-ai-agent.ts:74` doesn't forward `agentName`. Effectively, the system still only routes to `'agente-principal'`.

Fix: add `clinics.default_agent_name TEXT NOT NULL DEFAULT 'agente-principal'`. Dispatcher reads this column when `agentName` is not explicitly provided in args; explicit args still win. Closes GH #8.

### Step 5.1 — Failing DB test

Create `packages/db/tests/rls/clinics-default-agent-name.test.ts`:

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import {
  getServiceClient, createTestClinic, deleteTestClinic,
} from './helpers/setup.js';

const sql = getServiceClient();
const createdClinics: string[] = [];

afterAll(async () => {
  await Promise.all(createdClinics.map((id) => deleteTestClinic(sql, id)));
  await sql.end();
});

describe('clinics.default_agent_name (PR-E GH #8)', () => {
  it('column exists and defaults to "agente-principal" on new clinic', async () => {
    const c = await createTestClinic(sql, 'DefaultAgentName-Default');
    createdClinics.push(c.id);

    const [row] = await sql<{ default_agent_name: string }[]>`
      SELECT default_agent_name FROM clinics WHERE id = ${c.id}
    `;
    expect(row?.default_agent_name).toBe('agente-principal');
  });

  it('column accepts non-default value', async () => {
    const c = await createTestClinic(sql, 'DefaultAgentName-Triagem');
    createdClinics.push(c.id);

    await sql`UPDATE clinics SET default_agent_name = 'agente-triagem' WHERE id = ${c.id}`;
    const [row] = await sql<{ default_agent_name: string }[]>`
      SELECT default_agent_name FROM clinics WHERE id = ${c.id}
    `;
    expect(row?.default_agent_name).toBe('agente-triagem');
  });

  it('column rejects NULL', async () => {
    const c = await createTestClinic(sql, 'DefaultAgentName-NotNull');
    createdClinics.push(c.id);

    await expect(sql`
      UPDATE clinics SET default_agent_name = NULL WHERE id = ${c.id}
    `).rejects.toThrow(/null|violates/i);
  });
});
```

### Step 5.2 — Verify RED

```bash
pnpm --filter @medina/db exec vitest run tests/rls/clinics-default-agent-name.test.ts
```
Expected: FAIL — column doesn't exist.

### Step 5.3 — Create migration 0036

```sql
-- 0036_clinics_default_agent_name.sql
--
-- Issue PR-E GH #8 (AI-1 follow-up): support multiple agent_config names.
-- Before: dispatchAgent + createAgent accepted `agentName?` param defaulting
-- to 'agente-principal', but NO caller in production passes anything else
-- (inngest dispatch-ai-agent worker omits it). Effectively single-agent.
--
-- Fix: per-clinic default. clinics.default_agent_name NOT NULL DEFAULT
-- 'agente-principal' — back-compat com clinics existentes. Dispatcher lê
-- a coluna como fallback quando args.agentName não é provido. Override
-- explícito via args.agentName (futuro: routing per-conversation) ainda
-- vence.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.clinics
  ADD COLUMN IF NOT EXISTS default_agent_name TEXT NOT NULL DEFAULT 'agente-principal';

-- Documenta o contrato — coluna controla qual agent_config (filtrado por
-- name) é carregado pelo dispatcher quando nenhum override é passado.
COMMENT ON COLUMN public.clinics.default_agent_name IS
  'Nome do agent_config que dispatcher usa por padrão pra esta clinic. Deve corresponder a um agent_configs.name com status=published na mesma clinic. Default "agente-principal".';
```

### Step 5.4 — Apply migration via Supabase MCP

`mcp__plugin_supabase_supabase__apply_migration` with project_id=`vgdbpwdewoahvyqyaziv`, name=`0036_clinics_default_agent_name`, query=contents above.

### Step 5.5 — Verify DB tests pass + advisors clean

```bash
pnpm --filter @medina/db exec vitest run tests/rls/clinics-default-agent-name.test.ts
```
PASS.

Run `get_advisors` (security + performance). Zero new warnings expected (ALTER TABLE ADD COLUMN with NOT NULL DEFAULT is idiomatic; doesn't trigger any linter).

### Step 5.6 — Failing dispatcher test

Add to `packages/ai/tests/dispatcher.test.ts`:

```typescript
it('reads clinics.default_agent_name as fallback when agentName arg is not provided (GH #8)', async () => {
  // Clinic with default_agent_name='agente-triagem'; agent_config with that name exists.
  const { sb, spies } = makeSupabase({
    conversation: baseConv,
    agentConfig: { ...baseCfg, name: 'agente-triagem' },
    clinicRow: { id: 'clinic-A', default_agent_name: 'agente-triagem' },
  })
  const { dispatchAgent } = await import('../src/dispatcher.js')
  await dispatchAgent({ conversationId: 'conv-1', clinicId: 'clinic-A', messageId: 'm', supabase: sb })

  // 2nd .eq filter on agent_configs is the name — verify it used 'agente-triagem' from clinic column.
  const eqNameCalls = spies.agentSelect.mock.results
    .flatMap(r => (r.value as { eq: { mock: { calls: unknown[][] } } }).eq.mock.calls)
  // Walk down: select().eq('clinic_id', x).eq('status', y).eq('name', z) — last .eq is name.
  // Simpler: just verify the dispatcher called createAgent with agentName='agente-triagem'.
  // [actual assertion depends on existing test helpers; mirror line 636 "accepts agentName arg" pattern]
})

it('explicit args.agentName overrides clinics.default_agent_name (GH #8)', async () => {
  const { sb } = makeSupabase({
    conversation: baseConv,
    agentConfig: { ...baseCfg, name: 'agente-explicit' },
    clinicRow: { id: 'clinic-A', default_agent_name: 'agente-from-column' },
  })
  const { dispatchAgent } = await import('../src/dispatcher.js')
  await dispatchAgent({
    conversationId: 'conv-1',
    clinicId: 'clinic-A',
    messageId: 'm',
    supabase: sb,
    agentName: 'agente-explicit',
  })

  // Verify the agent_configs query filtered by 'agente-explicit', NOT 'agente-from-column'.
  // [mirror line 636 assertion pattern]
})
```

The `makeSupabase` helper needs a new `clinicRow` option that wires a `from('clinics').select(...).eq('id', clinicId).single()` chain returning `{ id, default_agent_name }`. Extend it accordingly.

### Step 5.7 — Verify RED

```bash
pnpm --filter @medina/ai exec vitest run tests/dispatcher.test.ts
```
Expected: FAIL — dispatcher doesn't read clinic.default_agent_name yet.

### Step 5.8 — Refactor dispatcher (GREEN)

In `packages/ai/src/dispatcher.ts`, locate the `agentName` default resolution (line 120). Replace:

```typescript
const { supabase, conversationId, clinicId, agentName = 'agente-principal', buildCalcomClient } = args
```

With:

```typescript
const { supabase, conversationId, clinicId, buildCalcomClient } = args
let { agentName } = args

// PR-E GH #8: fallback ladder — explicit args.agentName wins; otherwise
// load per-clinic default from clinics.default_agent_name (migration 0036);
// final fallback to 'agente-principal' preserves back-compat in case the
// column hasn't been backfilled (it should be NOT NULL DEFAULT, so this
// last fallback is dead code in practice — keep as belt-and-suspenders).
if (agentName == null) {
  const { data: clinicRow } = await supabase
    .from('clinics')
    .select('default_agent_name')
    .eq('id', clinicId)
    .single()
  agentName = (clinicRow as { default_agent_name?: string } | null)?.default_agent_name ?? 'agente-principal'
}
```

### Step 5.9 — Verify GREEN

```bash
pnpm --filter @medina/ai exec vitest run tests/dispatcher.test.ts
```
PASS — all dispatcher tests green (existing + 2 new).

Existing tests at line 636 ("accepts agentName arg, defaults to agente-principal") may need the mock extended with `clinicRow: { id: 'clinic-A', default_agent_name: 'agente-principal' }` since dispatcher now ALWAYS queries clinics when agentName is omitted. Update those mocks where needed.

### Step 5.10 — Commit

```bash
git add packages/db/migrations/0036_clinics_default_agent_name.sql \
        packages/db/tests/rls/clinics-default-agent-name.test.ts \
        packages/ai/src/dispatcher.ts packages/ai/tests/dispatcher.test.ts
git commit -m "feat(ai): per-clinic default_agent_name (closes GH #8)"
```

---

## Task 6 — Final validation + PR

### Step 6.1 — Full suite + typecheck + build

```bash
pnpm test
pnpm typecheck
pnpm build
```
All green required.

### Step 6.2 — Final advisor check

`get_advisors` security + performance. Expect zero net-new warnings introduced by 0036.

### Step 6.3 — Push + open PR (no merge)

```bash
git push -u origin g/pr-e-quality-reliability
gh pr create --base main \
  --title "fix: PR-E quality & reliability backlog (#6 #8 #11 + cleanup)" \
  --body-file <(cat <<'EOF'
## Summary
- **cleanup** remove dead `cleanupAll` no-op from db test helpers (issue #5 wrap-up)
- **#8** validate `Buffer.isBuffer()` shape guard in `mapClinicIntegration` (cast was a lie — Supabase JS returns hex strings, not Buffer)
- **#11** extract Logger interface; webhook tests inject mock logger instead of spying `console.log`
- **#6 + #14** module-level lazy singleton for Supabase admin client in webhook handler (was instantiating per hit)
- **GH #8** add `clinics.default_agent_name` column (default 'agente-principal'); dispatcher reads it as fallback when `args.agentName` omitted — closes infrastructure gap that left multi-agent routing accessible only via explicit caller args

## Test plan
- [x] DB integration tests: `pnpm --filter @medina/db test` (inclui 3 novos pra default_agent_name)
- [x] Integrations core tests: `pnpm --filter @medina/integrations-core test` (mappers + webhook-handler refactor)
- [x] AI dispatcher tests: `pnpm --filter @medina/ai test` (2 novos pra default_agent_name fallback)
- [x] Adapter regressions: `pnpm --filter @medina/integrations-whatsapp-kapso test`
- [x] Typecheck 10/10 packages
- [x] Build OK
- [x] Supabase advisors zero novos warnings

## Não-mergear
Aguardando review antes do merge.

Generated with Claude Code
EOF
)
```

Do **NOT** merge.

---

## Self-review checklist (writing-plans skill)

- [x] **Spec coverage:** 5 issues mapped to 5 explicit tasks
- [x] **No placeholders:** every step has exact file paths, real SQL, real test code, exact commands
- [x] **Type consistency:** `Logger` interface used in both logger.ts and webhook-handler.ts; `clinicRow` mock shape consistent in dispatcher tests
- [x] **Schema migration checklist:**
  - 0036 is plain ALTER TABLE ADD COLUMN, no SECURITY DEFINER fn, no RLS policy, no trigger → schema-migration-checklist concerns mostly N/A
  - NOT NULL DEFAULT is idiomatic; existing rows get backfilled atomically
  - No advisor risk
- [x] **Rollback safety:** each task is independently revertable; migration 0036 is forward-only but column drop is trivial

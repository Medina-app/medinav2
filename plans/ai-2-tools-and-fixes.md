# AI-2 — Tools (escalate, collect_info, check_business_hours) + Bug Fixes

> **For agentic workers:** REQUIRED SUB-SKILL — superpowers:executing-plans (inline). Steps use `- [ ]` checkboxes for tracking.

**Goal:** Wire 3 first-class tools into the Mastra agent, fix 3 latent bugs (#7, #8, novo #11), and add `clinics.business_hours` schema so check_business_hours has data to read.

**Architecture:** Each tool is a `createTool({ id, description, inputSchema, execute })` from `@mastra/core/tools` with closure-captured `ToolContext { clinicId, conversationId, supabaseAdmin }`. `dispatchAgent` builds the tool record from `agent_config.tools[]` (jsonb array of names), passes it to `createAgent`, then post-hoc inspects `result.steps[]` to (a) emit per-tool Langfuse spans and (b) detect `escalate_to_human` to skip outbound text insertion when state already flipped. `agent.generate(messages, { temperature, maxTokens, maxSteps: 5 })` applies config-driven params (fix #7).

**Tech Stack:** TypeScript estrito · `@mastra/core` 1.32.1 · `@openrouter/ai-sdk-provider` 2.9.0 · Zod · Vitest · Supabase · `date-fns-tz` (NEW dep) · langfuse 3.x.

---

## Context

AI-1 entregou agente Mastra Sonnet 4.5 respondendo via OpenRouter com traces Langfuse, toggle "IA atendendo" UI mapping `ai_handling` ↔ `waiting_human`. Smoke prod validou apenas geração de texto — não tools, não fluxo de escalação.

AI-2 entrega o mínimo pra agente operar com responsabilidade: tool de saída segura (`escalate_to_human`), estruturação conversacional (`collect_patient_info`), consciência temporal (`check_business_hours`). Sem isso, agente alucina disponibilidade ("podemos atender agora!" às 23h) e nunca devolve controle pra humano.

Durante exploração descobri 3 bugs:

- **#7** — `agent_config.temperature` e `agent_config.max_tokens` carregados de DB (`agent-factory.ts:32-33`) mas NUNCA passados pro modelo. Dispatcher chama `agent.generate(messages)` sem options. Resultado: defaults do modelo (Sonnet 4.5 default ~1, ~4k) ignoram config. Verificado em prod: `temperature=0.70` no DB mas modelo usa default.
- **#8** — `'agente-principal'` hardcoded em `dispatcher.ts:72,97`. Multi-agent routing (futuro: agente-triagem, agente-pos-consulta) não suportado. AI-2 prepara estrutura.
- **#11 (novo)** — `toggle-ai-handling-action.ts:44-48` chama `sb.rpc('transition_conversation_state', { p_conversation_id, p_new_state, p_reason })` mas função em prod tem assinatura `(conv_id uuid, new_state text, reason text)`. Verificado via Supabase MCP: `pg_get_function_arguments → "conv_id uuid, new_state text, reason text DEFAULT NULL::text"`. Toggle UI **silenciosamente quebrado** em prod desde CHAT-3 — RPC retorna erro "function not found", action surfaces `{ error: ... }`. Test mocka `sb.rpc` então escapa CI. AI-2 vai usar essa mesma RPC no escalate tool, então fix é parte do escopo.

## Out of Scope

- Filtros do inbox por state/agent (CHAT-7)
- RAG / knowledge base lookups (AI-3)
- `confirm_appointment` tool com calendar integration (AI-4)
- Guardrails / moderação (AI-5)
- Multi-agent dispatch real (estruturado mas hardcoded em 'agente-principal')
- Atualização da tabela `patients` por collect_patient_info (AI-3)

## Discovered State (verified via Supabase MCP em prod)

```
clinics columns: id, name, slug, plan, trial_ends_at, metadata jsonb, deleted_at, created_at, updated_at
  → NO business_hours column yet ✓ migration 0016 needed

agent_configs em prod (clinic sao-lucas):
  name='agente-principal', status='published', temperature=0.70, max_tokens=1024,
  model='anthropic/claude-sonnet-4-5', tools=[] (jsonb array vazio)

transition_conversation_state(conv_id uuid, new_state text, reason text DEFAULT NULL)
  → toggle action está chamando com p_conversation_id (BUG #11)
```

## Files Touched (mapa)

**Create:**
- `packages/db/migrations/0016_clinic_business_hours.sql`
- `packages/db/src/types/business-hours.ts`
- `packages/ai/src/tools/escalate.ts`
- `packages/ai/src/tools/collect-info.ts`
- `packages/ai/src/tools/business-hours.ts`
- `packages/ai/src/tools/build.ts` (renamed from index.ts logic; keep index.ts as barrel)
- `packages/ai/tests/tools/escalate.test.ts`
- `packages/ai/tests/tools/collect-info.test.ts`
- `packages/ai/tests/tools/business-hours.test.ts`
- `packages/ai/tests/tools/build.test.ts`
- `plans/ai-2-tools-and-fixes.md` (cópia deste plano no repo)

**Modify:**
- `packages/db/src/schema/clinics.ts` (add businessHours column)
- `packages/ai/src/types.ts` (extend ToolContext with supabase + tighten field type)
- `packages/ai/src/agent-factory.ts` (accept tools param, fix #7 + #8 surface)
- `packages/ai/src/dispatcher.ts` (build tools from config, escalate-aware outbox, fix #7/#8)
- `packages/ai/src/tools/index.ts` (delete old stubs, export new tools)
- `packages/ai/tests/agent-factory.test.ts` (cover temperature/maxTokens/agentName)
- `packages/ai/tests/dispatcher.test.ts` (cover tool wiring + escalate skip)
- `packages/ai/package.json` (add date-fns-tz, zod)
- `packages/db/scripts/seed-agent-config.ts` (default tools array + system prompt update)
- `apps/web/app/[slug]/inbox/_components/MessageBubble.tsx` (system message branch)
- `apps/web/app/[slug]/inbox/toggle-ai-handling-action.ts` (fix #11: RPC param names)
- `apps/web/app/[slug]/inbox/toggle-ai-handling-action.test.ts` (fix expected RPC args)

---

## Tasks

### Task 1: Worktree setup + plan file no repo

**Files:**
- Create worktree branch: `g/ai-2-tools-and-fixes`
- Create: `plans/ai-2-tools-and-fixes.md`

- [ ] **Step 1:** Verify clean main, run `git status` from repo root.
- [ ] **Step 2:** Create worktree via skill `using-git-worktrees`. Path: `C:\Users\gabri\Desktop\medina\medinav2\.git\worktrees\ai-2-tools`. Branch from `main`.
- [ ] **Step 3:** `cd` into worktree. Verify recent commits visible (`f43d7b4` should be HEAD).
- [ ] **Step 4:** Copy this plan content to `plans/ai-2-tools-and-fixes.md` in the worktree.
- [ ] **Step 5:** `git add plans/ && git commit -m "docs(ai): plan AI-2 tools + fixes"`

### Task 2: Migration 0016 — clinics.business_hours

**Files:**
- Create: `packages/db/migrations/0016_clinic_business_hours.sql`

Schema-migration-checklist verificado:
- ✓ Coluna nova, não há FK cross-tenant nova
- ✓ Não há trigger ou function novo
- ✓ Não há policy nova (herda RLS de clinics)
- ✓ Default JSON estático (não usa auth.uid())

- [ ] **Step 1:** Write migration:

```sql
-- ─── 0016: clinics.business_hours ────────────────────────────────────────────
-- Stores per-clinic business hours so the AI agent (check_business_hours tool)
-- can answer questions like "you're open now?" deterministically. Default is
-- monday-friday 08:00-18:00 America/Sao_Paulo, weekends closed (null).
-- Schema: { timezone: string (IANA), schedule: { day → { open, close } | null } }

ALTER TABLE public.clinics
  ADD COLUMN IF NOT EXISTS business_hours jsonb NOT NULL
  DEFAULT '{
    "timezone": "America/Sao_Paulo",
    "schedule": {
      "monday":    {"open":"08:00","close":"18:00"},
      "tuesday":   {"open":"08:00","close":"18:00"},
      "wednesday": {"open":"08:00","close":"18:00"},
      "thursday":  {"open":"08:00","close":"18:00"},
      "friday":    {"open":"08:00","close":"18:00"},
      "saturday":  null,
      "sunday":    null
    }
  }'::jsonb;

COMMENT ON COLUMN public.clinics.business_hours IS
  'IANA timezone + per-day open/close (HH:MM 24h). null day = closed. Read by AI agent check_business_hours tool.';
```

- [ ] **Step 2:** Apply via Supabase MCP `apply_migration` with name `clinic_business_hours`.
- [ ] **Step 3:** Verify advisor: `mcp__plugin_supabase_supabase__get_advisors` filter `security`. Expect zero new warnings.
- [ ] **Step 4:** Verify in prod: `SELECT business_hours FROM clinics WHERE slug='sao-lucas';` — should show populated default.
- [ ] **Step 5:** Commit: `git commit -m "feat(db): clinics.business_hours column for AI agent (closes #X)"`.

### Task 3: BusinessHours type + Drizzle schema

**Files:**
- Create: `packages/db/src/types/business-hours.ts`
- Modify: `packages/db/src/schema/clinics.ts`

- [ ] **Step 1:** Create the type file:

```ts
// packages/db/src/types/business-hours.ts
export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'

export interface DayHours {
  /** HH:MM 24-hour, e.g. "08:00" */
  open: string
  /** HH:MM 24-hour, e.g. "18:00" */
  close: string
}

export interface BusinessHours {
  /** IANA tz, e.g. "America/Sao_Paulo" */
  timezone: string
  /** null entry = closed that day */
  schedule: Record<DayOfWeek, DayHours | null>
}
```

- [ ] **Step 2:** Add `businessHours` to clinics Drizzle schema:

```ts
// packages/db/src/schema/clinics.ts — add to existing pgTable definition
import type { BusinessHours } from '../types/business-hours.js'
// ...inside table definition, after metadata, before deletedAt:
businessHours: jsonb('business_hours').$type<BusinessHours>().notNull(),
```

- [ ] **Step 3:** Verify typecheck: `pnpm --filter @medina/db typecheck`. Expect zero errors.
- [ ] **Step 4:** Commit: `git commit -m "feat(db): BusinessHours type + drizzle column"`.

### Task 4: Verify Mastra tool API + add deps

**Files:**
- Modify: `packages/ai/package.json`

Pre-implementation verification (Plan agent flagged LOW confidence on `maxOutputTokens` vs `maxTokens` rename in some Mastra versions).

- [ ] **Step 1:** Add `date-fns-tz` (timezone math) and `zod` (tool schemas) deps:

```jsonc
// packages/ai/package.json — add to dependencies
"date-fns-tz": "^3.2.0",
"date-fns": "^3.6.0",
"zod": "^3.23.8"
```

- [ ] **Step 2:** Run `pnpm install` from repo root.
- [ ] **Step 3:** Verify the actual Agent.generate options shape: open `node_modules/@mastra/core/dist/agent/index.d.ts` and grep for `temperature` and `maxTokens` (or `maxOutputTokens`). Document the actual field name in a code comment in dispatcher.ts when implementing Task 10. **Stop and ask user if the field name is neither `maxTokens` nor `maxOutputTokens`.**
- [ ] **Step 4:** Verify `createTool` exists at `@mastra/core/tools`: same approach. Document import path.
- [ ] **Step 5:** Commit: `git commit -m "chore(ai): add date-fns-tz, zod for AI-2 tools"`.

### Task 5: ToolContext extension + test helper

**Files:**
- Modify: `packages/ai/src/types.ts`
- Create: `packages/ai/tests/tools/_helpers.ts`

- [ ] **Step 1:** Extend `ToolContext` in types.ts:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'

export interface ToolContext {
  clinicId: string
  conversationId: string  // was optional → now required (every tool runs inside a dispatch)
  patientId?: string
  /** Service-role client. Tools must use this to bypass RLS for inserts/updates. */
  supabase: SupabaseClient
}
```

- [ ] **Step 2:** Create `packages/ai/tests/tools/_helpers.ts`:

```ts
import { vi } from 'vitest'
import type { ToolContext } from '../../src/types.js'

/**
 * Builds a fully-mocked Supabase client supporting the chains tools use:
 *   from('X').select(...).eq(...).single() / maybeSingle()
 *   from('X').update(...).eq(...).eq(...)
 *   from('X').insert(...).select(...).single()
 *   rpc('fn_name', { args })
 *
 * Each call resolves with { data, error }. Override per-table behavior via
 * the `tables` map. Default behavior: every call returns { data: null, error: null }.
 */
export function buildMockSupabase(
  tables: Record<string, { single?: unknown; maybeSingle?: unknown; insertResult?: unknown }> = {},
  rpcResult: { data?: unknown; error?: { message: string } | null } = { error: null },
) {
  const rpc = vi.fn().mockResolvedValue(rpcResult)

  const from = vi.fn((table: string) => {
    const cfg = tables[table] ?? {}
    const single = vi.fn().mockResolvedValue({ data: cfg.single ?? null, error: null })
    const maybeSingle = vi.fn().mockResolvedValue({ data: cfg.maybeSingle ?? null, error: null })

    const eq2: { eq: typeof eq2['eq']; single: typeof single; maybeSingle: typeof maybeSingle } = {
      eq: vi.fn(() => eq2),
      single,
      maybeSingle,
    }
    const select = vi.fn(() => ({ ...eq2, eq: vi.fn(() => eq2) }))

    const update = vi.fn(() => ({
      eq: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) })),
    }))

    const insert = vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn().mockResolvedValue({ data: cfg.insertResult ?? { id: 'new-id' }, error: null }),
      })),
      // For audit_logs / system messages where we don't need the inserted row back:
      then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
    }))

    return { select, update, insert }
  })

  return { from, rpc, supabase: { from, rpc } }
}

export function buildToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const { supabase } = buildMockSupabase()
  return {
    clinicId: 'clinic-A',
    conversationId: 'conv-1',
    supabase: supabase as never,
    ...overrides,
  }
}
```

- [ ] **Step 3:** Run `pnpm --filter @medina/ai typecheck`. Expect zero errors.
- [ ] **Step 4:** Commit: `git commit -m "test(ai): tool test helpers + ToolContext extension"`.

### Task 6: escalate_to_human tool — TDD

**Files:**
- Test: `packages/ai/tests/tools/escalate.test.ts`
- Create: `packages/ai/src/tools/escalate.ts`

- [ ] **Step 1:** Write failing tests covering 5 cases. Skeleton:

```ts
// packages/ai/tests/tools/escalate.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildEscalateTool } from '../../src/tools/escalate.js'
import { buildToolContext, buildMockSupabase } from './_helpers.js'

describe('escalate_to_human', () => {
  it('transitions ai_handling → waiting_human via RPC with reason', async () => {
    const { supabase, rpc, from } = buildMockSupabase({
      conversations: { single: { id: 'conv-1', state: 'ai_handling', clinic_id: 'clinic-A' } },
    })
    const ctx = buildToolContext({ supabase: supabase as never })
    const tool = buildEscalateTool(ctx)

    await tool.execute({ context: { reason: 'paciente com urgência médica' } })

    expect(rpc).toHaveBeenCalledWith('transition_conversation_state', {
      conv_id: 'conv-1',
      new_state: 'waiting_human',
      reason: 'agent_escalated:paciente com urgência médica',
    })
    expect(from).toHaveBeenCalledWith('messages')  // system msg insert
    expect(from).toHaveBeenCalledWith('audit_logs')  // audit insert
  })

  it('inserts system message with sender_type=system and content_type=system', async () => { /* ... */ })
  it('rejects when conversation belongs to different clinic (cross-tenant)', async () => { /* ... */ })
  it('rejects when conversation already in waiting_human (idempotent error)', async () => { /* ... */ })
  it('writes audit_logs row with action=agent.tool.escalate, user_id=null', async () => { /* ... */ })
})
```

- [ ] **Step 2:** Run tests, verify all FAIL with "buildEscalateTool not defined" or similar.
- [ ] **Step 3:** Implement minimal:

```ts
// packages/ai/src/tools/escalate.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'

const InputSchema = z.object({
  reason: z.string().min(3).max(500).describe(
    'Motivo conciso da escalação (e.g., "paciente com urgência médica", "questão fora do escopo do agente").',
  ),
})

export function buildEscalateTool(ctx: ToolContext) {
  return createTool({
    id: 'escalate_to_human',
    description: 'Transfere a conversa pra um atendente humano quando o agente não pode resolver (urgências médicas, questões clínicas específicas, paciente irritado, fora do escopo). Após chamar essa tool, o agente NÃO deve continuar tentando resolver — apenas se despeça brevemente.',
    inputSchema: InputSchema,
    execute: async ({ context }) => {
      const { reason } = context
      const { supabase, clinicId, conversationId } = ctx

      // 1. Cross-tenant guard: load conversation, verify clinic_id matches.
      const { data: conv, error: cErr } = await supabase
        .from('conversations')
        .select('id, state, clinic_id')
        .eq('id', conversationId)
        .single()
      if (cErr || !conv) throw new Error(`escalate: conversation lookup failed: ${cErr?.message}`)
      if ((conv as { clinic_id: string }).clinic_id !== clinicId) {
        throw new Error(`escalate: cross-tenant violation`)
      }

      // 2. Idempotency: refuse if already escalated.
      if ((conv as { state: string }).state === 'waiting_human') {
        return { ok: false, error: 'já_transferida', message: 'Conversa já está com humano.' }
      }

      // 3. State transition via RPC (validates allowed transitions, audit-logs).
      // Param names match prod function signature: conv_id, new_state, reason (NOT p_*).
      const { error: rpcErr } = await supabase.rpc('transition_conversation_state', {
        conv_id: conversationId,
        new_state: 'waiting_human',
        reason: `agent_escalated:${reason}`,
      })
      if (rpcErr) throw new Error(`escalate: RPC failed: ${rpcErr.message}`)

      // 4. Insert system message visible in inbox.
      const { error: mErr } = await supabase.from('messages').insert({
        clinic_id: clinicId,
        conversation_id: conversationId,
        direction: 'outbound',
        sender_type: 'system',
        content_type: 'system',
        content: `🤖 IA escalou pra humano: ${reason}`,
        delivery_status: 'sent',
        outbox_status: null,  // not for outbox worker — inbox-only
      })
      if (mErr) throw new Error(`escalate: system message insert failed: ${mErr.message}`)

      // 5. Audit log (transition_conversation_state already audits state change;
      //    this row captures the tool invocation specifically).
      await supabase.from('audit_logs').insert({
        clinic_id: clinicId,
        user_id: null,  // service_role context
        action: 'agent.tool.escalate',
        resource: 'conversations',
        resource_id: conversationId,
        metadata: { reason, tool: 'escalate_to_human' },
      })

      return { ok: true, message: 'Conversa transferida pra humano. Despeça-se brevemente e não continue tentando ajudar.' }
    },
  })
}
```

- [ ] **Step 4:** Run tests, verify all PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(ai): escalate_to_human tool"`.

### Task 7: collect_patient_info tool — TDD

**Files:**
- Test: `packages/ai/tests/tools/collect-info.test.ts`
- Create: `packages/ai/src/tools/collect-info.ts`

- [ ] **Step 1:** Tests:

```ts
import { describe, it, expect } from 'vitest'
import { buildCollectInfoTool, ALLOWED_FIELDS } from '../../src/tools/collect-info.js'
import { buildMockSupabase, buildToolContext } from './_helpers.js'

describe('collect_patient_info', () => {
  it.each(ALLOWED_FIELDS)('accepts allowed field: %s', async (field) => {
    const { supabase, from } = buildMockSupabase({
      conversations: { single: { metadata: {} } },
    })
    const tool = buildCollectInfoTool(buildToolContext({ supabase: supabase as never }))
    const result = await tool.execute({ context: { field } })
    expect(result.ok).toBe(true)
    expect(from).toHaveBeenCalledWith('conversations')
  })

  it('rejects unknown field via Zod', async () => {
    const tool = buildCollectInfoTool(buildToolContext())
    await expect(
      tool.execute({ context: { field: 'cpf' as never } }),
    ).rejects.toThrow()
  })

  it('marks conversation.metadata.collected_info[field] with ISO timestamp', async () => {
    /* assert update payload */
  })

  it('returns instruction string for the LLM (does not preempt patient response)', async () => {
    const tool = buildCollectInfoTool(buildToolContext({
      supabase: buildMockSupabase({ conversations: { single: { metadata: {} } } }).supabase as never,
    }))
    const r = await tool.execute({ context: { field: 'name' } })
    expect((r as { instruction: string }).instruction).toMatch(/peça.*nome/i)
  })

  it('preserves existing metadata when adding collected_info', async () => { /* ... */ })

  it('writes audit_logs entry action=agent.tool.collect_info', async () => { /* ... */ })
})
```

- [ ] **Step 2:** Run, verify FAIL.
- [ ] **Step 3:** Implement:

```ts
// packages/ai/src/tools/collect-info.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ToolContext } from '../types.js'

export const ALLOWED_FIELDS = ['name', 'age', 'reason', 'phone_alt'] as const
type Field = typeof ALLOWED_FIELDS[number]

const InputSchema = z.object({
  field: z.enum(ALLOWED_FIELDS).describe(
    'Campo que precisa ser perguntado ao paciente. ' +
    'name=nome completo, age=idade, reason=motivo da consulta, phone_alt=telefone alternativo.',
  ),
})

const INSTRUCTIONS: Record<Field, string> = {
  name:      'Peça o nome completo do paciente de forma cordial.',
  age:       'Peça a idade do paciente.',
  reason:    'Peça o motivo da consulta de forma empática.',
  phone_alt: 'Peça um telefone alternativo pra contato.',
}

export function buildCollectInfoTool(ctx: ToolContext) {
  return createTool({
    id: 'collect_patient_info',
    description: 'Marca que o agente precisa coletar uma informação estruturada do paciente. NÃO preenche dados — apenas estrutura o fluxo conversacional. Retorna instrução pra você fazer a pergunta no próximo turno.',
    inputSchema: InputSchema,
    execute: async ({ context }) => {
      const { field } = context
      const { supabase, clinicId, conversationId } = ctx

      // Read current metadata (cross-tenant guard via clinic_id eq).
      const { data: conv, error: cErr } = await supabase
        .from('conversations')
        .select('metadata, clinic_id')
        .eq('id', conversationId)
        .eq('clinic_id', clinicId)
        .single()
      if (cErr || !conv) throw new Error(`collect_info: lookup failed: ${cErr?.message}`)

      const metadata = ((conv as { metadata: Record<string, unknown> }).metadata ?? {}) as Record<string, unknown>
      const collected = ((metadata['collected_info'] as Record<string, string>) ?? {})
      const nextMetadata = {
        ...metadata,
        collected_info: { ...collected, [field]: new Date().toISOString() },
      }

      const { error: uErr } = await supabase
        .from('conversations')
        .update({ metadata: nextMetadata })
        .eq('id', conversationId)
        .eq('clinic_id', clinicId)
      if (uErr) throw new Error(`collect_info: update failed: ${uErr.message}`)

      await supabase.from('audit_logs').insert({
        clinic_id: clinicId, user_id: null,
        action: 'agent.tool.collect_info',
        resource: 'conversations', resource_id: conversationId,
        metadata: { field, tool: 'collect_patient_info' },
      })

      return { ok: true, field, instruction: INSTRUCTIONS[field] }
    },
  })
}
```

- [ ] **Step 4:** Run, verify PASS.
- [ ] **Step 5:** Commit: `git commit -m "feat(ai): collect_patient_info tool"`.

### Task 8: check_business_hours tool — TDD

**Files:**
- Test: `packages/ai/tests/tools/business-hours.test.ts`
- Create: `packages/ai/src/tools/business-hours.ts`

Use `date-fns-tz` (NÃO `Date` nativo) pra timezone math. Tests usam `vi.setSystemTime()` pra controlar `Date.now()`.

- [ ] **Step 1:** Tests covering 6+ cases:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildBusinessHoursTool } from '../../src/tools/business-hours.js'
import { buildMockSupabase, buildToolContext } from './_helpers.js'

const SCHEDULE_DEFAULT = {
  timezone: 'America/Sao_Paulo',
  schedule: {
    monday:    { open: '08:00', close: '18:00' },
    tuesday:   { open: '08:00', close: '18:00' },
    wednesday: { open: '08:00', close: '18:00' },
    thursday:  { open: '08:00', close: '18:00' },
    friday:    { open: '08:00', close: '18:00' },
    saturday:  null, sunday: null,
  },
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('check_business_hours', () => {
  it('returns is_open=true on weekday at 10:00 BRT', async () => {
    // 2026-05-06 = wednesday. 10:00 BRT = 13:00 UTC.
    vi.setSystemTime(new Date('2026-05-06T13:00:00Z'))
    const { supabase } = buildMockSupabase({
      clinics: { single: { business_hours: SCHEDULE_DEFAULT } },
    })
    const tool = buildBusinessHoursTool(buildToolContext({ supabase: supabase as never }))
    const r = await tool.execute({ context: {} }) as { is_open: boolean; current_period: string }
    expect(r.is_open).toBe(true)
    expect(r.current_period).toBe('morning')
  })

  it('returns is_open=false on weekday at 22:00 BRT', async () => {
    vi.setSystemTime(new Date('2026-05-07T01:00:00Z'))  // wed 22h BRT
    /* ... */
  })

  it('returns is_open=false on saturday', async () => {
    vi.setSystemTime(new Date('2026-05-09T13:00:00Z'))  // sat 10h BRT
    /* ... */
  })

  it('returns next_open ISO when closed (next monday 08:00)', async () => {
    vi.setSystemTime(new Date('2026-05-10T13:00:00Z'))  // sun 10h BRT
    const r = await buildBusinessHoursTool(/*...*/).execute({ context: {} }) as { next_open: string }
    expect(r.next_open).toBe('2026-05-11T11:00:00.000Z')  // mon 08:00 BRT = 11:00 UTC
  })

  it('respects custom timezone (America/Manaus = UTC-4)', async () => { /* ... */ })

  it('falls back to default schedule when clinic.business_hours is null', async () => {
    const { supabase } = buildMockSupabase({
      clinics: { single: { business_hours: null } },
    })
    /* should still work, return is_open based on default mon-fri 08-18 SP */
  })

  it('current_period afternoon when hour ≥ 12 and < close', async () => { /* ... */ })

  it('throws on cross-tenant clinic mismatch', async () => { /* ... */ })
})
```

- [ ] **Step 2:** Run, verify FAIL.
- [ ] **Step 3:** Implement using `date-fns-tz`:

```ts
// packages/ai/src/tools/business-hours.ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { formatInTimeZone, toZonedTime, fromZonedTime } from 'date-fns-tz'
import { addDays, parse, set } from 'date-fns'
import type { ToolContext } from '../types.js'
import type { BusinessHours, DayOfWeek } from '@medina/db/types/business-hours'

const DEFAULT_HOURS: BusinessHours = {
  timezone: 'America/Sao_Paulo',
  schedule: {
    monday: { open: '08:00', close: '18:00' }, tuesday: { open: '08:00', close: '18:00' },
    wednesday: { open: '08:00', close: '18:00' }, thursday: { open: '08:00', close: '18:00' },
    friday: { open: '08:00', close: '18:00' },
    saturday: null, sunday: null,
  },
}

const DAY_KEYS: DayOfWeek[] = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']

export function buildBusinessHoursTool(ctx: ToolContext) {
  return createTool({
    id: 'check_business_hours',
    description: 'Verifica se a clínica está aberta agora e retorna próximo horário de abertura. Use antes de propor agendamento imediato pra evitar prometer disponibilidade fora do expediente.',
    inputSchema: z.object({}).describe('Sem argumentos — usa horário atual e config da clínica.'),
    execute: async () => {
      const { supabase, clinicId } = ctx

      const { data: clinic, error } = await supabase
        .from('clinics')
        .select('business_hours, id')
        .eq('id', clinicId)
        .single()
      if (error || !clinic) throw new Error(`business_hours: clinic lookup failed: ${error?.message}`)
      if ((clinic as { id: string }).id !== clinicId) throw new Error('cross-tenant')

      const hours: BusinessHours = (clinic as { business_hours: BusinessHours | null }).business_hours ?? DEFAULT_HOURS
      const tz = hours.timezone

      const now = new Date()
      const localDow = parseInt(formatInTimeZone(now, tz, 'i'), 10)  // 1=mon..7=sun
      const dayKey = DAY_KEYS[localDow % 7]
      const today = hours.schedule[dayKey]

      const localHHMM = formatInTimeZone(now, tz, 'HH:mm')

      let isOpen = false
      let currentPeriod: 'morning' | 'afternoon' | 'closed' = 'closed'
      if (today) {
        if (localHHMM >= today.open && localHHMM < today.close) {
          isOpen = true
          const localHour = parseInt(localHHMM.slice(0, 2), 10)
          currentPeriod = localHour < 12 ? 'morning' : 'afternoon'
        }
      }

      const nextOpen = computeNextOpen(now, hours)
      return { is_open: isOpen, next_open: nextOpen, current_period: currentPeriod, timezone: tz }
    },
  })
}

function computeNextOpen(now: Date, hours: BusinessHours): string {
  const tz = hours.timezone
  for (let i = 0; i < 8; i++) {
    const candidate = addDays(now, i)
    const dow = parseInt(formatInTimeZone(candidate, tz, 'i'), 10)
    const dayKey = DAY_KEYS[dow % 7]
    const day = hours.schedule[dayKey]
    if (!day) continue
    // Build local datetime: today's date at day.open in tz, convert to UTC.
    const localYmd = formatInTimeZone(candidate, tz, 'yyyy-MM-dd')
    const localOpenStr = `${localYmd}T${day.open}:00`
    const utcDate = fromZonedTime(localOpenStr, tz)
    if (utcDate > now) return utcDate.toISOString()
  }
  throw new Error('no open day found in next 8 days — check business_hours config')
}
```

- [ ] **Step 4:** Run, verify PASS. Watch `tz` parsing edge cases (DST in March/October).
- [ ] **Step 5:** Commit: `git commit -m "feat(ai): check_business_hours tool with date-fns-tz"`.

### Task 9: buildToolsFromConfig dispatcher — TDD

**Files:**
- Test: `packages/ai/tests/tools/build.test.ts`
- Create: `packages/ai/src/tools/build.ts`
- Modify: `packages/ai/src/tools/index.ts` (delete old stubs, re-export)

- [ ] **Step 1:** Tests:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildToolsFromConfig } from '../../src/tools/build.js'
import { buildToolContext } from './_helpers.js'

describe('buildToolsFromConfig', () => {
  it('returns record keyed by tool id for each known name', () => {
    const ctx = buildToolContext()
    const tools = buildToolsFromConfig(ctx, ['escalate_to_human', 'check_business_hours'])
    expect(Object.keys(tools).sort()).toEqual(['check_business_hours', 'escalate_to_human'])
  })

  it('ignores unknown tool names with a warn (not throw)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tools = buildToolsFromConfig(buildToolContext(), ['escalate_to_human', 'sql_injection'])
    expect(Object.keys(tools)).toEqual(['escalate_to_human'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown tool: sql_injection'))
  })

  it('returns empty record for empty array', () => {
    expect(buildToolsFromConfig(buildToolContext(), [])).toEqual({})
  })

  it('all 3 tools registerable together', () => {
    const tools = buildToolsFromConfig(buildToolContext(), [
      'escalate_to_human', 'collect_patient_info', 'check_business_hours',
    ])
    expect(Object.keys(tools).sort()).toEqual([
      'check_business_hours', 'collect_patient_info', 'escalate_to_human',
    ])
  })
})
```

- [ ] **Step 2:** Run, FAIL.
- [ ] **Step 3:** Implement:

```ts
// packages/ai/src/tools/build.ts
import type { ToolContext } from '../types.js'
import { buildEscalateTool } from './escalate.js'
import { buildCollectInfoTool } from './collect-info.js'
import { buildBusinessHoursTool } from './business-hours.js'

type ToolBuilder = (ctx: ToolContext) => unknown

const REGISTRY: Record<string, ToolBuilder> = {
  escalate_to_human:    buildEscalateTool,
  collect_patient_info: buildCollectInfoTool,
  check_business_hours: buildBusinessHoursTool,
}

export function buildToolsFromConfig(ctx: ToolContext, toolNames: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const name of toolNames) {
    const builder = REGISTRY[name]
    if (!builder) {
      console.warn(`buildToolsFromConfig: unknown tool: ${name}`)
      continue
    }
    out[name] = builder(ctx)
  }
  return out
}
```

- [ ] **Step 4:** Replace `packages/ai/src/tools/index.ts` with barrel re-exports (delete old stubs):

```ts
export { buildEscalateTool } from './escalate.js'
export { buildCollectInfoTool } from './collect-info.js'
export { buildBusinessHoursTool } from './business-hours.js'
export { buildToolsFromConfig } from './build.js'
```

- [ ] **Step 5:** Run, verify PASS. Run full test suite — old stubs being removed may break other tests; if so, update those imports.
- [ ] **Step 6:** Commit: `git commit -m "feat(ai): buildToolsFromConfig + delete tool stubs"`.

### Task 10: Fix #7 + #8 in agent-factory — TDD

**Files:**
- Modify: `packages/ai/src/agent-factory.ts`
- Modify: `packages/ai/tests/agent-factory.test.ts`

- [ ] **Step 1:** Add 2 failing tests to existing `agent-factory.test.ts`:

```ts
it('passes tools record to Agent constructor', async () => {
  const tools = { escalate_to_human: { id: 'escalate_to_human' } }
  const { agent } = await createAgent({ clinicId, supabase: sb, agentName: 'agente-principal', tools })
  expect(agentSpy.mock.calls[0][0].tools).toBe(tools)
})

it('agentName defaults to agente-principal when not provided', async () => {
  await createAgent({ clinicId, supabase: sb })
  expect(sbEqMock).toHaveBeenCalledWith('name', 'agente-principal')
})
```

- [ ] **Step 2:** Run, FAIL.
- [ ] **Step 3:** Modify `agent-factory.ts`:

```ts
export interface CreateAgentOpts {
  clinicId: string
  agentName?: string
  supabase: SupabaseClient
  /** Tool record produced by buildToolsFromConfig. */
  tools?: Record<string, unknown>
}

export async function createAgent(opts: CreateAgentOpts): Promise<CreateAgentResult> {
  const { clinicId, agentName = 'agente-principal', supabase, tools } = opts
  // ... existing load ...
  const agent = new Agent({
    id: `clinic:${clinicId}:agent:${config.name}:v${config.version}`,
    name: config.name,
    model,
    instructions: config.systemPrompt,
    ...(tools ? { tools } : {}),
  })
  return { agent, config }
}
```

NOTA: temperature/maxTokens são aplicados em `agent.generate(messages, { ... })` — feito em Task 11. Aqui apenas mudança da default `agentName`.

- [ ] **Step 4:** Run, PASS.
- [ ] **Step 5:** Commit: `git commit -m "fix(ai): agent-factory accepts tools + default agentName=agente-principal (closes #8 partial)"`.

### Task 11: Wire tools + temperature/maxTokens + escalate-aware outbox

**Files:**
- Modify: `packages/ai/src/dispatcher.ts`
- Modify: `packages/ai/tests/dispatcher.test.ts`

- [ ] **Step 1:** Add failing tests:

```ts
it('passes temperature and maxTokens to agent.generate', async () => {
  // cfg.temperature=0.2, cfg.max_tokens=100
  await dispatchAgent(args)
  expect(agentGenerateMock).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ temperature: 0.2, maxTokens: 100, maxSteps: 5 }),
  )
})

it('passes tools built from agent_config.tools to createAgent', async () => {
  // cfg.tools = ['escalate_to_human', 'check_business_hours']
  await dispatchAgent(args)
  expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({
    tools: expect.objectContaining({
      escalate_to_human: expect.any(Object),
      check_business_hours: expect.any(Object),
    }),
  }))
})

it('skips outbound message insert when result.steps shows escalate_to_human was called', async () => {
  agentGenerateMock.mockResolvedValueOnce({
    text: 'Tudo bem, vou transferir.',
    toolCalls: [{ toolName: 'escalate_to_human' }],
    steps: [{ toolCalls: [{ toolName: 'escalate_to_human' }] }],
    totalUsage: { inputTokens: 10, outputTokens: 5 },
  })
  const result = await dispatchAgent(args)
  // outbound 'ai' message should still be inserted (the goodbye text)
  // but skipped if text is empty.
  expect(supabase.from('messages').insert).toHaveBeenCalled()
  // tool span should be emitted to langfuse:
  expect(traceSpanMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'tool:escalate_to_human' }))
})

it('accepts agentName arg, defaults to agente-principal', async () => {
  await dispatchAgent({ ...args, agentName: 'agente-triagem' })
  expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'agente-triagem' }))
})
```

- [ ] **Step 2:** Run, FAIL.
- [ ] **Step 3:** Modify dispatcher.ts (key changes only — not full rewrite):

```ts
import { buildToolsFromConfig } from './tools/build.js'

export interface DispatchAgentArgs {
  conversationId: string
  clinicId: string
  messageId: string
  supabase: SupabaseClient
  /** Optional override; defaults to 'agente-principal'. Multi-agent routing future-proofing. */
  agentName?: string
}

export async function dispatchAgent(args: DispatchAgentArgs): Promise<DispatchResult> {
  const { supabase, conversationId, clinicId, agentName = 'agente-principal' } = args
  // ... existing conversation load ...
  // ... existing agent_config load — REPLACE hardcoded 'agente-principal' with agentName var:
  const { data: cfg } = await supabase
    .from('agent_configs')
    .select('id, system_prompt, model, temperature, max_tokens, name, tools')  // ADD tools
    .eq('clinic_id', clinicId)
    .eq('status', 'published')
    .eq('name', agentName)  // CHANGED: was hardcoded
    .maybeSingle()
  // ...

  // 4. Build tools + agent.
  const toolNames = (cfg.tools as string[] | null) ?? []
  const toolCtx: ToolContext = { clinicId, conversationId, supabase }
  const tools = buildToolsFromConfig(toolCtx, toolNames)
  const { agent } = await createAgent({ clinicId, agentName, supabase, tools })

  // 5. Generate with config-driven temperature/maxTokens (FIX #7).
  // Field name verified at Task 4 — if Mastra version uses maxOutputTokens, swap here.
  const result = await agent.generate(messages, {
    temperature: cfg.temperature,
    maxTokens: cfg.max_tokens,
    maxSteps: 5,
  })

  // ... existing langfuse generation.end ...

  // 6. Detect escalation: tool inserted system msg + flipped state already.
  const steps = ((result as { steps?: Array<{ toolCalls?: Array<{ toolName: string }> }> }).steps) ?? []
  const escalated = steps.some(s => (s.toolCalls ?? []).some(tc => tc.toolName === 'escalate_to_human'))

  // Emit one Langfuse span per tool call (post-hoc, since Mastra doesn't auto-attach).
  for (const step of steps) {
    for (const tc of step.toolCalls ?? []) {
      try {
        (trace as { span?: (a: Record<string, unknown>) => void } | null)
          ?.span?.({ name: `tool:${tc.toolName}`, input: tc })
      } catch { /* swallow */ }
    }
  }

  // 7. Persist response to outbox UNLESS escalate was called and text is empty/very short.
  const text = (result as { text?: string }).text ?? ''
  if (escalated && text.trim().length < 3) {
    // Tool already inserted system message; nothing to send.
    return { messageId: '', traceId: trace?.id ?? null, tokensIn, tokensOut }
  }
  // ... existing message insert with text ...
}
```

- [ ] **Step 4:** Run, PASS. Re-run full ai test suite.
- [ ] **Step 5:** Commit: `git commit -m "fix(ai): apply temperature/maxTokens, wire tools, escalate-aware outbox (closes #7, #8)"`.

### Task 12: Update seed-agent-config defaults

**Files:**
- Modify: `packages/db/scripts/seed-agent-config.ts`

- [ ] **Step 1:** Change defaults:

```ts
const DEFAULT_TOOLS = ['escalate_to_human', 'check_business_hours', 'collect_patient_info']

const DEFAULT_PROMPT = `Você é o assistente virtual da {{clinic_name}}, uma clínica médica.

REGRAS:
- NÃO dê diagnósticos ou recomendações médicas. Sempre indique consulta presencial.
- NÃO recomende medicamentos.
- Seja cordial, conciso, em português brasileiro.

FERRAMENTAS DISPONÍVEIS:
- escalate_to_human(reason): use quando paciente pede médico, urgência, irritação, ou questão fora do escopo. Após escalar, despeça-se brevemente.
- check_business_hours(): SEMPRE chame antes de propor agendamento imediato. Não invente disponibilidade.
- collect_patient_info(field): quando precisar de nome/idade/motivo/telefone alternativo, chame essa tool e faça a pergunta no próximo turno.`

// In the upsert payload:
const payload = {
  /* ... */
  temperature: '0.7',
  max_tokens: 800,  // was 1024 — tighter pra reduzir custo (300 input + 800 output ≈ $0.005/turno Sonnet 4.5)
  tools: DEFAULT_TOOLS,
  system_prompt: prompt,
}
```

- [ ] **Step 2:** Apply to prod (sao-lucas) — `pnpm tsx packages/db/scripts/seed-agent-config.ts` ou via supabase MCP `execute_sql` UPDATE direto. **Re-publica versão nova** (versão+1, archived_at na velha) — script já lida com idempotência.
- [ ] **Step 3:** Verify in prod via MCP: `SELECT name, version, tools, temperature, max_tokens FROM agent_configs WHERE status='published' AND name='agente-principal';`. Confirma tools=array de 3 strings.
- [ ] **Step 4:** Commit: `git commit -m "chore(db): seed default tools + tighter max_tokens for agente-principal"`.

### Task 13: Fix #11 — toggle action RPC param names

**Files:**
- Modify: `apps/web/app/[slug]/inbox/toggle-ai-handling-action.ts`
- Modify: `apps/web/app/[slug]/inbox/toggle-ai-handling-action.test.ts`

- [ ] **Step 1:** Update test expectations FIRST (TDD-by-fix):

```ts
// linha ~103:
expect(sb.rpcMock).toHaveBeenCalledWith(
  'transition_conversation_state',
  expect.objectContaining({
    conv_id: '11111111-1111-1111-1111-111111111111',  // was p_conversation_id
    new_state: 'waiting_human',                       // was p_new_state
    reason: 'human_paused_ai',                        // was p_reason
  }),
)
// idem nos outros 2 testes que checam args
```

- [ ] **Step 2:** Run test → FAIL (expected: action ainda passa `p_*`).
- [ ] **Step 3:** Fix action:

```ts
// toggle-ai-handling-action.ts linha 44-48:
const { error } = await sb.rpc('transition_conversation_state', {
  conv_id: parsed.data.conversationId,
  new_state: parsed.data.newState,
  reason,
})
```

- [ ] **Step 4:** Run, PASS.
- [ ] **Step 5:** **Manual smoke test em prod localhost:** abre conversa, clica toggle. Verifica que ANTES retornava erro silencioso e AGORA muda state. Loga via Network tab que ação retorna `{ ok: true }`.
- [ ] **Step 6:** Commit: `git commit -m "fix(inbox): toggle action RPC param names (closes #11)"`.

### Task 14: MessageBubble system message styling

**Files:**
- Modify: `apps/web/app/[slug]/inbox/_components/MessageBubble.tsx`

Frontend-design skill ativo. Estilo Luma: balão centralizado, fundo neutral, texto secundário, ícone 🤖, sem badge IA.

- [ ] **Step 1:** Add system branch:

```tsx
const isOutbound = m.direction === 'outbound';
const isAi = m.senderType === 'ai';
const isSystem = m.senderType === 'system';
const state = isOutbound && !isSystem ? getMessageVisualState(m) : null;
const isFailed = state?.kind === 'failed';

// System messages render as a centered, muted notice — distinct from regular bubbles.
if (isSystem) {
  return (
    <li className="flex justify-center my-1">
      <div
        className="max-w-[85%] rounded-md px-3 py-1.5 bg-[var(--luma-bg-subtle)] border border-[var(--luma-border)] text-center"
        data-slot="system-message"
      >
        <p className="text-[11.5px] text-[var(--luma-text-secondary)] whitespace-pre-wrap break-words">
          {m.content ?? <em className="opacity-60">(sistema)</em>}
        </p>
        <RelativeTime
          date={m.createdAt}
          className="text-[10px] text-[var(--luma-text-tertiary)] mt-0.5 block"
        />
      </div>
    </li>
  );
}

// ...resto do component (isAi / isOutbound / inbound) inalterado
```

- [ ] **Step 2:** Add test in `MessageBubble.test.tsx` (criar se não existir):

```ts
it('renders system message as centered muted notice (no IA badge)', () => {
  render(<MessageBubble message={{ ...base, senderType: 'system', content: '🤖 IA escalou: urgência' }} />)
  expect(screen.queryByText('IA')).toBeNull()
  expect(screen.getByTestId('system-message')).toBeInTheDocument()
})
```

- [ ] **Step 3:** Verify visually: smoke test (Task 15) já cobre.
- [ ] **Step 4:** Commit: `git commit -m "feat(inbox): system message styling for AI tool events"`.

### Task 15: Verification + smoke test em produção

Skill `verification-before-completion` ativo. ZERO claims sem evidência.

- [ ] **Step 1:** Run all checks:
```bash
pnpm typecheck    # zero errors
pnpm test         # all green, ~35+ new tests
pnpm build        # success
```

- [ ] **Step 2:** Supabase advisor check:
```
mcp__plugin_supabase_supabase__get_advisors type=security
```
Expect: zero new criticals.

- [ ] **Step 3:** Push branch + open PR (skill `finishing-a-development-branch`):
```
gh pr create --title "feat(ai): AI-2 tools + fix #7 #8 #11" --body <see template>
```

- [ ] **Step 4:** **Smoke prod (após merge to main + Vercel deploy):**

  **Caso 1 — escalate happy path:**
  - WhatsApp pra clinic sao-lucas: "preciso falar com um médico urgentemente"
  - Verificar:
    - [ ] Toggle "IA atendendo" UI flipa pra desligado em <5s (router.refresh via Centrifugo)
    - [ ] Inbox mostra mensagem system: "🤖 IA escalou pra humano: ..."
    - [ ] DB: `state='waiting_human'` em conversations
    - [ ] DB: 1 row em audit_logs com action='conversation.state_changed' (RPC) + 1 row action='agent.tool.escalate' (manual)
    - [ ] Langfuse trace tem child span `tool:escalate_to_human`
    - [ ] Próxima inbound: NÃO dispara agente (state ≠ ai_handling — skip em dispatcher.ts:60)

  **Caso 2 — business hours:**
  - WhatsApp 22h BRT: "posso ir aí agora?"
  - Verificar:
    - [ ] Langfuse mostra tool call `check_business_hours`
    - [ ] Resposta menciona "fechado" + oferece próximo horário (manhã seguinte 8h)

  **Caso 3 — collect_info:**
  - WhatsApp: "quero marcar consulta"
  - Verificar:
    - [ ] Langfuse mostra tool call `collect_patient_info` com field='name' ou 'reason'
    - [ ] DB: `conversations.metadata.collected_info[name]=<ISO>`
    - [ ] Próximo turno: agente pergunta o nome

  **Caso 4 — fix #7 verificável:**
  - Via supabase MCP: `UPDATE agent_configs SET temperature=0.1, max_tokens=80 WHERE name='agente-principal' AND status='published';`
  - WhatsApp: "qual seu nome?"
  - Verificar:
    - [ ] Resposta tá curta (≤80 tokens)
    - [ ] Langfuse mostra usage.outputTokens ≤80
    - [ ] Resposta determinística (rodar 2x, comparar)
  - **Reverter** após smoke: temperature=0.7, max_tokens=800.

  **Caso 5 — toggle UI fix #11:**
  - Em /sao-lucas/inbox, abre conversa em ai_handling, clica toggle pra desligar
  - Verificar:
    - [ ] Network tab: action retorna `{ ok: true }` (antes do fix retornaria error com "function not found")
    - [ ] state muda pra waiting_human
    - [ ] audit_logs tem novo row action='conversation.state_changed' reason='human_paused_ai'

- [ ] **Step 5:** Se TODOS os 5 casos passarem, deixa PR aberto pra review humano + CodeRabbit. **NÃO mergeia automaticamente.**
- [ ] **Step 6:** Se algum caso falhar, abrir issue no GitHub linkando log + Langfuse trace, parar e pedir feedback.

---

## Verification Commands (referência rápida)

```bash
# Local
pnpm --filter @medina/ai test
pnpm --filter @medina/ai typecheck
pnpm --filter @medina/db test
pnpm typecheck && pnpm build

# Prod state checks via Supabase MCP
SELECT business_hours FROM clinics WHERE slug='sao-lucas';
SELECT name, version, tools, temperature FROM agent_configs WHERE clinic_id='aef23929-c470-424b-b8ce-78358fac60b8' AND status='published';
SELECT action, count(*) FROM audit_logs WHERE clinic_id='aef23929-c470-424b-b8ce-78358fac60b8' AND created_at > now() - interval '1 hour' GROUP BY action;

# Langfuse: filter by sessionId clinic:aef23929-c470-424b-b8ce-78358fac60b8:conv:<conversationId>
# Tool spans nomeados tool:escalate_to_human, tool:check_business_hours, tool:collect_patient_info
```

## PR Body Template

```markdown
## Summary
- 3 tools Mastra: escalate_to_human, collect_patient_info, check_business_hours
- Fix #7: temperature + max_tokens agora aplicados em agent.generate
- Fix #8: dispatchAgent aceita agentName (default 'agente-principal'); structural prep multi-agent
- Fix #11 (descoberto durante AI-2): toggle-ai-handling-action chamava RPC com nomes errados (silently broken)
- Schema: clinics.business_hours jsonb (migration 0016)
- UI: MessageBubble renderiza sender_type='system' como notice central
- Seed: agente-principal default tools = 3 ativas, max_tokens=800 (custo ~$0.005/turno Sonnet 4.5)

## Test plan
- [x] 35+ unit tests verdes (escalate, collect_info, business_hours, build, agent-factory, dispatcher)
- [x] pnpm typecheck zero erros
- [x] pnpm build success
- [x] Supabase advisor zero novos warnings
- [x] Smoke prod 5 casos (ver plans/ai-2-tools-and-fixes.md task 15)

## Não entrega
- Filtros inbox por state (CHAT-7)
- RAG knowledge base (AI-3)
- confirm_appointment com calendar (AI-4)
- Guardrails / moderação (AI-5)
```

---

## Risks & Mitigations

1. **Mastra v1.32.1 field name `maxTokens` vs `maxOutputTokens`** — Plan agent flagged LOW confidence. Verificação obrigatória em Task 4 step 3 ANTES de implementar Task 11. Se for `maxOutputTokens`, ajustar uma linha em dispatcher.ts.

2. **`maxSteps` default em Mastra** — Default histórico do AI SDK é 1 (single-shot). Se Mastra não overrida, tool calls não são seguidos por turn de texto. Mitigação: SEMPRE passar `maxSteps: 5` explícito (Task 11).

3. **Langfuse tool spans não auto-anexam** — Mastra emite OTel mas Langfuse não consome via OTel exporter (precisa pacote separado). Solução AI-2: emite span manual post-hoc inspecionando `result.steps`. Confiável mas duplica esforço. AI-3+ pode migrar pra OTel exporter.

4. **DST (timezone) em check_business_hours** — `date-fns-tz` lida com DST automaticamente via IANA. Risco em datas de transição (BR aboliu DST mas se voltar). Tests cobrem só cases canônicos. Risco aceitável pra MVP.

5. **Idempotência escalate** — Se LLM chamar escalate 2x mesmo turno, segunda chamada vai falhar no check `state==='waiting_human'` e retornar `{ ok: false, error: 'já_transferida' }`. LLM recebe erro e pode tentar continuar. Mitigação: já implementado.

6. **System message pollution se LLM abusa** — Cada tool call gera 1+ system message. Conversation pode ficar verbosa se LLM chamar escalate em loop. Mitigação: `maxSteps: 5` cap + audit trail mostra abuso. Monitorar Langfuse.

7. **Cross-tenant FK validation** (schema-migration-checklist) — `clinics.business_hours` é coluna nova sem FK, sem cross-tenant risk. Triggers existentes em messages/conversations cobrem inserts feitos pelos tools.

8. **Audit log user_id NULL** — Service role context → `auth.uid()` retorna NULL → audit_logs.user_id NULL. Schema já permite (column nullable). audit_conversation_change trigger em 0011 usa `(SELECT auth.uid())` wrapper — OK.

9. **Toggle action smoke prod** — Fix #11 muda comportamento em prod. Se algum atendente confiou no toggle "funcionando" silenciosamente (estado nunca mudava de fato), agora vai mudar de fato. Documentar em PR.

---

## Self-Review checklist (writing-plans skill)

- [x] Spec coverage: 3 tools + 2 fixes + 1 fix novo (#11) + schema + seed + UI = todos cobertos.
- [x] Sem placeholders TBD/TODO em SQL, Zod schemas ou execute bodies.
- [x] Type consistency: `BusinessHours`, `ToolContext`, `DispatchAgentArgs` mantêm signatures consistentes entre tasks.
- [x] schema-migration-checklist: migration 0016 sem RLS/trigger/FK novo, default jsonb seguro, audit log user_id nullable já preparado, search_path N/A (sem function nova).
- [x] TDD: cada tool tem step "Write tests → Run FAIL → Implement → Run PASS → Commit".
- [x] Verification end-to-end: 5 casos smoke prod com checks ✅ específicos.

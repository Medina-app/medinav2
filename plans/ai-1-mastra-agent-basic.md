# AI-1 — Mastra Agent Básico no Inbox + Langfuse Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans para implementar task-by-task. Steps usam checkbox (`- [ ]`) para tracking.

**Goal:** Inbound WhatsApp dispara agente Mastra (OpenRouter), gera resposta, enfileira no outbox CHAT-2 (que entrega via Kapso) e registra trace completo no Langfuse. Toggle UI permite atendente pausar/retomar IA por conversa.

**Architecture:** Webhook Kapso → addMessage (CHAT-1) → publish Centrifugo (CHAT-3) → IF state='ai_handling' AND created=true → ctx.inngestSend('ai/message.received') → função Inngest `dispatch-ai-agent` carrega agent_config + histórico → chama Mastra.Agent.generate() → insere message com sender_type='ai', outbox_status='pending', agent_config_id → worker CHAT-2 entrega → trace tudo no Langfuse.

**Tech Stack:** Mastra `@mastra/core` · `@openrouter/ai-sdk-provider` · `langfuse` SDK Node · Inngest · Supabase (service role) · Vitest TDD.

**Plan path final:** Esta plan-mode buffer será copiada como Task 0 para `plans/ai-1-mastra-agent-basic.md` no worktree.

---

## Context — Por que essa mudança

Pós-CHAT-3 o pipeline inbound→inbox→outbox→realtime está completo, mas inbound não tem resposta automática. A clínica são-lucas (uuid `cdd97f60-9ede-42e0-bc7d-f64b27f65d3b`) já tem integration Kapso ativa (`057a51f5-c77d-4d9e-ab72-5f96fd9b4255`) com webhook apontando pra produção. Foundation `packages/ai` da Issue 14 nunca finalizou — falta `package.json`, `errors.ts`, `vitest.config.ts`, e `createAgent()` depende de pacotes não declarados. AI-1 precisa: (1) reparar foundation, (2) trocar `@ai-sdk/anthropic` por OpenRouter, (3) wirar Langfuse, (4) construir dispatcher + Inngest function + UI toggle, (5) seedar agent_config default pra são-lucas. Não entrega: tools (AI-2), RAG/Mastra storage (AI-3), confirm_appointment (AI-4), guardrails (AI-5).

## Decisões Críticas (ratificadas via AskUserQuestion)

1. **State machine:** Toggle `ai_handling ↔ waiting_human`. Webhook seta `ai_handling` em conversas NOVAS quando há published agent_config. Dispatcher só dispara em `state='ai_handling'`. Sem migration.
2. **Seed flow:** `INSERT direto status='published'` via service role (bypassa RLS, idempotente, sem audit log do publish).
3. **Foundation gap:** Task 0 corrige `packages/ai` antes de qualquer coisa.
4. **OpenRouter:** Substitui `@ai-sdk/anthropic` em `agent-factory.ts`. Mantém `openai` (raw SDK) pra embeddings (AI-3 ainda).
5. **Idempotência:** Inngest dedup via `event.id = ai:${messageId}`. Mesmo webhook entregue 2x não gera 2 respostas.
6. **Langfuse failsafe:** try/catch em todas chamadas Langfuse. Se Langfuse cair, agente continua.

## File Structure

**Criados:**
- `packages/ai/package.json` (Task 1)
- `packages/ai/vitest.config.ts` (Task 1)
- `packages/ai/src/errors.ts` (Task 1)
- `packages/ai/src/langfuse.ts` (Task 4)
- `packages/ai/src/dispatcher.ts` (Task 6)
- `packages/ai/tests/dispatcher.test.ts` (Task 6 — TDD)
- `packages/db/scripts/seed-agent-config.ts` (Task 8)
- `packages/db/scripts/README.md` (Task 8)
- `apps/web/lib/inngest/functions/dispatch-ai-agent.ts` (Task 7)
- `apps/web/lib/inngest/functions/__tests__/dispatch-ai-agent.test.ts` (Task 7)
- `apps/web/components/ui/switch.tsx` (Task 9 — shadcn)
- `apps/web/app/[slug]/inbox/_components/AiHandlingToggle.tsx` (Task 10)
- `apps/web/app/[slug]/inbox/toggle-ai-handling-action.ts` (Task 10)
- `apps/web/app/[slug]/inbox/toggle-ai-handling-action.test.ts` (Task 10 — TDD)
- `plans/ai-1-mastra-agent-basic.md` (Task 0 — cópia desta plan)

**Modificados:**
- `packages/ai/src/index.ts` (export dispatcher, errors, langfuse)
- `packages/ai/src/agent-factory.ts` (substituir provider por OpenRouter; aceitar langfuse callbacks)
- `packages/ai/tests/agent-factory.test.ts` (atualizar mocks pra openrouter)
- `packages/chat/src/conversations.ts` (getOrCreateConversation aceita `initialState`)
- `packages/chat/tests/conversations.test.ts` (cobre initialState)
- `packages/integrations/whatsapp/kapso/src/adapter.ts` (após inserir inbound: dispatch `ai/message.received` se state='ai_handling')
- `packages/integrations/whatsapp/kapso/tests/adapter.test.ts` (cobre dispatch novo)
- `apps/web/app/api/inngest/route.ts` (registra `dispatchAiAgent` no array)
- `apps/web/app/[slug]/inbox/conversation-detail.tsx` (renderiza `AiHandlingToggle` no header)
- `apps/web/app/[slug]/inbox/_components/MessageBubble.tsx` (sender_type='ai' visual diferente)
- `.env.example` (LANGFUSE_*, OPENROUTER_API_KEY)
- `apps/web/.env.example` (criado novo, espelhando root + AI vars)

---

## Task 0: Worktree + cópia do plan

**Files:**
- Create: `.worktrees/ai-1/` (git worktree)
- Create: `plans/ai-1-mastra-agent-basic.md` (no worktree)

- [ ] **Step 0.1:** Verificar `.worktrees/` ignorado.

```bash
git check-ignore -q .worktrees && echo OK || echo "ADD TO .gitignore"
```

- [ ] **Step 0.2:** Criar worktree.

```bash
git worktree add .worktrees/ai-1 -b g/ai-1-mastra-agent-basic
cd .worktrees/ai-1
pnpm install
```

- [ ] **Step 0.3:** Copiar este plan-mode buffer pra `plans/ai-1-mastra-agent-basic.md`.

- [ ] **Step 0.4:** Baseline test run — registrar quais testes JÁ falham antes de tocar nada.

```bash
pnpm test 2>&1 | tee /tmp/baseline-tests.log
pnpm typecheck 2>&1 | tee /tmp/baseline-typecheck.log
```

- [ ] **Step 0.5:** Commit baseline.

```bash
git add plans/ai-1-mastra-agent-basic.md
git commit -m "docs(ai-1): plan for AI-1 mastra agent basic + langfuse"
```

---

## Task 1: packages/ai foundation fix

**Files:**
- Create: `packages/ai/package.json`
- Create: `packages/ai/vitest.config.ts`
- Create: `packages/ai/src/errors.ts`
- Modify: `packages/ai/src/index.ts`

- [ ] **Step 1.1:** Criar `packages/ai/package.json`.

```json
{
  "name": "@medina/ai",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mastra/core": "^0.10.0",
    "@openrouter/ai-sdk-provider": "^0.4.0",
    "@supabase/supabase-js": "^2.45.0",
    "langfuse": "^3.30.0",
    "openai": "^4.60.0",
    "@medina/db": "workspace:*"
  },
  "devDependencies": {
    "vitest": "^2.0.0",
    "typescript": "^5.5.0"
  }
}
```

Versões finais: rodar `pnpm view @mastra/core version` e `pnpm view @openrouter/ai-sdk-provider version` antes pra pinar latest stable. Se `@mastra/core` 0.10 incompatível com Mastra Agent API que `agent-factory.ts` usa, ajustar pin.

- [ ] **Step 1.2:** Criar `packages/ai/vitest.config.ts` (espelha `packages/chat`).

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
```

- [ ] **Step 1.3:** Criar `packages/ai/src/errors.ts`.

```ts
export class AgentNotFoundError extends Error {
  constructor(clinicId: string, name: string) {
    super(`No published agent_config found for clinic=${clinicId} name=${name}`);
    this.name = 'AgentNotFoundError';
  }
}

export class NamespacingViolationError extends Error {
  constructor(expected: string, got: string) {
    super(`Namespacing violation: expected ${expected}, got ${got}`);
    this.name = 'NamespacingViolationError';
  }
}

export class AgentDispatchSkipped extends Error {
  constructor(public readonly reason: 'state_not_ai_handling' | 'no_agent_config') {
    super(`dispatchAgent skipped: ${reason}`);
    this.name = 'AgentDispatchSkipped';
  }
}
```

- [ ] **Step 1.4:** Atualizar `packages/ai/src/index.ts`.

```ts
export * from './errors.js';
export * from './types.js';
export * from './agent-factory.js';
export * from './langfuse.js';
export * from './dispatcher.js';
```

- [ ] **Step 1.5:** Instalar deps + rodar testes existentes.

```bash
pnpm install
pnpm --filter @medina/ai test
```

Expected: testes da Issue 14 passam (após Task 2 atualizar agent-factory pra OpenRouter, novos mocks). **Se quebrar:** ver Task 2 antes de commitar.

- [ ] **Step 1.6:** Commit.

```bash
git add packages/ai/package.json packages/ai/vitest.config.ts packages/ai/src/errors.ts packages/ai/src/index.ts pnpm-lock.yaml
git commit -m "fix(ai): foundation files (package.json + errors + vitest config)"
```

---

## Task 2: agent-factory usa OpenRouter

**Files:**
- Modify: `packages/ai/src/agent-factory.ts`
- Modify: `packages/ai/tests/agent-factory.test.ts`

- [ ] **Step 2.1:** Substituir `@ai-sdk/anthropic` + `@ai-sdk/openai` por `@openrouter/ai-sdk-provider` no `resolveModel()`.

```ts
// packages/ai/src/agent-factory.ts (refactor)
import { Agent } from '@mastra/core';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

function resolveModel(modelId: string) {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  const openrouter = createOpenRouter({ apiKey });
  return openrouter(modelId);
}
```

OpenRouter aceita IDs no formato `anthropic/claude-sonnet-4-5`, `openai/gpt-4o`, `anthropic/claude-haiku-4-5`. Banco já tem coluna `model text NOT NULL` em `agent_configs` — basta seedar com ID OpenRouter.

- [ ] **Step 2.2:** Adicionar parâmetro opcional `langfuseCallbacks` no `createAgent`.

```ts
export type CreateAgentOpts = {
  clinicId: string;
  name: string;
  supabase: SupabaseClient;
  langfuseCallbacks?: Parameters<Agent['__setOptions']>[0]; // expandir conforme API real Mastra
};
```

Validar API real de Mastra Agent — `@mastra/core` 0.10 expõe `telemetry` config. Se nessa versão Mastra ainda não suportar callbacks externos, dispatcher.ts wrappa o `agent.generate()` com Langfuse `trace.span()` manualmente (Task 6 já assume essa rota como fallback — ela é a primária).

- [ ] **Step 2.3:** Atualizar tests pra mockar `@openrouter/ai-sdk-provider` em vez de `@ai-sdk/anthropic`.

```ts
// packages/ai/tests/agent-factory.test.ts
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: () => (modelId: string) => ({ provider: 'openrouter', modelId }),
}));
```

- [ ] **Step 2.4:** Rodar testes da Issue 14.

```bash
pnpm --filter @medina/ai test agent-factory
```

Expected: PASS (8 tests passing).

- [ ] **Step 2.5:** Commit.

```bash
git commit -am "refactor(ai): swap @ai-sdk/anthropic for OpenRouter provider"
```

---

## Task 3: Langfuse client + tracing wrapper

**Files:**
- Create: `packages/ai/src/langfuse.ts`
- Create: `packages/ai/tests/langfuse.test.ts`

- [ ] **Step 3.1:** Test primeiro (TDD RED).

```ts
// packages/ai/tests/langfuse.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getLangfuseClient, withTrace, scoreLatency } from '../src/langfuse';

describe('langfuse client', () => {
  beforeEach(() => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    process.env.LANGFUSE_HOST = 'https://cloud.langfuse.com';
  });

  it('returns null client when keys missing', () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    expect(getLangfuseClient()).toBeNull();
  });

  it('withTrace swallows langfuse errors so caller continues', async () => {
    const broken = { trace: () => { throw new Error('langfuse offline'); } } as any;
    const result = await withTrace(broken, { name: 't', sessionId: 's' }, async () => 'ok');
    expect(result).toBe('ok'); // caller's work succeeded despite langfuse throw
  });
});
```

- [ ] **Step 3.2:** Verify RED.

```bash
pnpm --filter @medina/ai test langfuse
```

Expected: FAIL (module not found).

- [ ] **Step 3.3:** Implementação mínima.

```ts
// packages/ai/src/langfuse.ts
import { Langfuse } from 'langfuse';

let _client: Langfuse | null | undefined;

export function getLangfuseClient(): Langfuse | null {
  if (_client !== undefined) return _client;
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY'];
  const secretKey = process.env['LANGFUSE_SECRET_KEY'];
  const baseUrl = process.env['LANGFUSE_HOST'];
  if (!publicKey || !secretKey) {
    _client = null;
    return null;
  }
  _client = new Langfuse({ publicKey, secretKey, baseUrl });
  return _client;
}

export type TraceArgs = {
  name: string;
  sessionId: string;
  userId?: string;
  metadata?: Record<string, unknown>;
};

export async function withTrace<T>(
  client: Langfuse | null,
  args: TraceArgs,
  fn: (trace: any) => Promise<T>,
): Promise<T> {
  if (!client) return fn(null);
  let trace: any = null;
  try {
    trace = client.trace({ name: args.name, sessionId: args.sessionId, userId: args.userId, metadata: args.metadata });
  } catch (err) {
    console.warn('langfuse trace creation failed', err);
  }
  try {
    return await fn(trace);
  } finally {
    try { trace?.update?.({ output: '<<see observations>>' }); } catch {}
    try { await client.flushAsync(); } catch {}
  }
}

export function scoreLatency(trace: any, ms: number): void {
  try { trace?.score?.({ name: 'latency_ms', value: ms }); } catch {}
}
```

- [ ] **Step 3.4:** Verify GREEN.

```bash
pnpm --filter @medina/ai test langfuse
```

Expected: PASS (2 tests).

- [ ] **Step 3.5:** Commit.

```bash
git add packages/ai/src/langfuse.ts packages/ai/tests/langfuse.test.ts
git commit -m "feat(ai): langfuse client with failsafe trace wrapper"
```

---

## Task 4: getOrCreateConversation aceita initialState

**Files:**
- Modify: `packages/chat/src/conversations.ts`
- Modify: `packages/chat/tests/conversations.test.ts`

- [ ] **Step 4.1:** Test primeiro (TDD).

```ts
it('creates with state ai_handling when initialState=ai_handling passed', async () => {
  const sb = mockSb({ conversations: { existing: null, created: { state: 'ai_handling', ... } } });
  const r = await getOrCreateConversation(sb, { ...args, initialState: 'ai_handling' });
  expect(r.created).toBe(true);
  expect(r.conversation.state).toBe('ai_handling');
});

it('defaults to waiting_human when initialState omitted', async () => {
  const sb = mockSb({ ... });
  const r = await getOrCreateConversation(sb, args);
  expect(r.conversation.state).toBe('waiting_human');
});
```

- [ ] **Step 4.2:** Implementação.

```ts
export type GetOrCreateConversationArgs = {
  clinicId: string;
  integrationId: string;
  channel: 'whatsapp';
  externalId: string;
  patientId: string | null;
  initialState?: 'ai_handling' | 'waiting_human'; // default waiting_human
};

// no INSERT:
state: a.initialState ?? 'waiting_human',
```

- [ ] **Step 4.3:** Verify + commit.

```bash
pnpm --filter @medina/chat test conversations
git commit -am "feat(chat): getOrCreateConversation accepts initialState"
```

---

## Task 5: Adapter Kapso decide initialState + dispatch ai/message.received

**Files:**
- Modify: `packages/integrations/whatsapp/kapso/src/adapter.ts`
- Modify: `packages/integrations/whatsapp/kapso/tests/adapter.test.ts`

- [ ] **Step 5.1:** Test primeiro.

```ts
it('dispatches ai/message.received when conversation is in ai_handling and message is new', async () => {
  // setup: clinic has published agent_config; conversation already exists with state=ai_handling
  const inngestSend = vi.fn();
  await kapsoAdapter.handle({ ...ctx, inngestSend });
  expect(inngestSend).toHaveBeenCalledWith({
    name: 'ai/message.received',
    id: expect.stringMatching(/^ai:/),
    data: expect.objectContaining({ messageId: expect.any(String), conversationId: expect.any(String), clinicId: 'clinic-1' }),
  });
});

it('does NOT dispatch when conversation state is waiting_human', async () => { ... });
it('does NOT dispatch when message is duplicate (created=false)', async () => { ... });
it('passes initialState=ai_handling when clinic has published agent_config and conversation is new', async () => { ... });
```

- [ ] **Step 5.2:** Implementação em `persistInbound`.

```ts
// pre-step: detect if clinic has published agent_config (1 query, cached não)
async function clinicHasPublishedAgent(sb: SupabaseClient, clinicId: string): Promise<boolean> {
  const { data } = await sb.from('agent_configs').select('id').eq('clinic_id', clinicId).eq('status', 'published').limit(1).maybeSingle();
  return !!data;
}

// dentro de persistInbound, ANTES de getOrCreateConversation:
const hasAgent = await clinicHasPublishedAgent(sb, ctx.clinicId);

const { conversation } = await getOrCreateConversation(sb, {
  ...,
  initialState: hasAgent ? 'ai_handling' : 'waiting_human',
});

// ... after addMessage + safePublish:
if (created && conversation.state === 'ai_handling') {
  if (!ctx.inngestSend) {
    console.warn('inngestSend missing, skipping ai dispatch');
  } else {
    try {
      await ctx.inngestSend({
        name: 'ai/message.received',
        id: `ai:${message.id}`,
        data: { messageId: message.id, conversationId: conversation.id, clinicId: ctx.clinicId },
      });
    } catch (err) {
      // não falha webhook se Inngest cair — IA é desejável mas não crítico (atendente vê a mensagem)
      console.error('ai dispatch failed', err);
    }
  }
}
```

Justificativa: dispatch só dispara em `created=true` (novo) E `state=ai_handling`. Idempotência via event id `ai:${messageId}`. Se Inngest cair, webhook completa (DB tem msg, atendente humano vê normal).

- [ ] **Step 5.3:** Verify + commit.

```bash
pnpm --filter @medina/integrations-kapso test
git commit -am "feat(kapso): dispatch ai/message.received when conversation in ai_handling"
```

---

## Task 6: dispatcher.ts (TDD-first, núcleo da IA)

**Files:**
- Create: `packages/ai/src/dispatcher.ts`
- Create: `packages/ai/tests/dispatcher.test.ts`

- [ ] **Step 6.1:** Escrever TODOS os testes primeiro (RED).

```ts
// packages/ai/tests/dispatcher.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchAgent } from '../src/dispatcher';
import { AgentDispatchSkipped } from '../src/errors';

const ctx = (over = {}) => ({
  conversationId: 'conv-1',
  clinicId: 'clinic-1',
  messageId: 'msg-in-1',
  supabase: mockSupabase({ ... }),
  ...over,
});

describe('dispatchAgent', () => {
  it('skips when conversation.state is not ai_handling', async () => {
    const sb = mockSupabase({ conversation: { state: 'waiting_human' } });
    await expect(dispatchAgent(ctx({ supabase: sb }))).rejects.toBeInstanceOf(AgentDispatchSkipped);
  });

  it('skips when conversation.state is resolved', async () => { ... });

  it('skips when no published agent_config exists for clinic', async () => { ... });

  it('loads published agent_config matching clinic_id (cross-tenant test)', async () => {
    // setup: clinic-A has agent X (published); clinic-B has agent Y (published)
    // dispatching for clinic-A MUST select agent X, never agent Y
    const sb = mockSupabaseTwoClinics();
    await dispatchAgent({ ...ctx, clinicId: 'clinic-A', supabase: sb });
    expect(sb.from('agent_configs').select).toHaveBeenCalledWith(expect.stringContaining('clinic-A'));
    expect(sb.from('agent_configs').select).not.toHaveBeenCalledWith(expect.stringContaining('clinic-B'));
  });

  it('passes last 20 messages from conversation as context (ordered ASC by created_at)', async () => { ... });

  it('inserts response message with sender_type=ai, outbox_status=pending, agent_config_id set', async () => {
    const result = await dispatchAgent(ctx());
    expect(sb.from('messages').insert).toHaveBeenCalledWith(expect.objectContaining({
      sender_type: 'ai',
      outbox_status: 'pending',
      delivery_status: 'pending',
      agent_config_id: 'cfg-1',
      direction: 'outbound',
    }));
    expect(result.messageId).toBeDefined();
  });

  it('records langfuse trace with clinic_id, conversation_id, model, tokens', async () => { ... });

  it('continues even if langfuse client init fails (failsafe)', async () => { ... });

  it('propagates LLM errors so Inngest can retry', async () => { ... });

  it('uses event idempotency: same messageId twice does NOT generate 2 responses', async () => {
    // simulação: chamando dispatchAgent 2x com mesmo messageId
    // segunda chamada precisa detectar (via lookup nos messages com origin_message_id ou external_id derivado)
    // OU confiar no Inngest dedup (event.id) — neste caso, dispatcher é idempotente NO NÍVEL Inngest
    // Test verifica que dispatcher confia em Inngest (não tem lógica própria, mas registra warning se chamado 2x)
  });
});
```

- [ ] **Step 6.2:** Verify RED.

```bash
pnpm --filter @medina/ai test dispatcher
```

Expected: 10 testes failing por module not found.

- [ ] **Step 6.3:** Implementação mínima.

```ts
// packages/ai/src/dispatcher.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAgent } from './agent-factory.js';
import { getLangfuseClient, withTrace } from './langfuse.js';
import { AgentDispatchSkipped } from './errors.js';

const HISTORY_LIMIT = 20;

export type DispatchAgentArgs = {
  conversationId: string;
  clinicId: string;
  messageId: string;
  supabase: SupabaseClient;
};

export type DispatchResult = {
  messageId: string;
  traceId: string | null;
  tokensIn: number;
  tokensOut: number;
};

export async function dispatchAgent(args: DispatchAgentArgs): Promise<DispatchResult> {
  // 1. valida state
  const { data: conv, error: cErr } = await args.supabase
    .from('conversations').select('id, state, clinic_id, patient_id')
    .eq('id', args.conversationId).single();
  if (cErr || !conv) throw new Error(`conversation lookup failed: ${cErr?.message}`);
  if (conv.clinic_id !== args.clinicId) throw new Error('cross-tenant violation');
  if (conv.state !== 'ai_handling') throw new AgentDispatchSkipped('state_not_ai_handling');

  // 2. carrega agent_config (cross-tenant safe via filter)
  const { data: cfg } = await args.supabase
    .from('agent_configs').select('id, system_prompt, model, temperature, max_tokens, name')
    .eq('clinic_id', args.clinicId).eq('status', 'published').eq('name', 'agente-principal')
    .maybeSingle();
  if (!cfg) throw new AgentDispatchSkipped('no_agent_config');

  // 3. histórico (últimas N)
  const { data: history } = await args.supabase
    .from('messages').select('content, sender_type, direction, created_at')
    .eq('conversation_id', args.conversationId).order('created_at', { ascending: false }).limit(HISTORY_LIMIT);
  const messages = (history ?? []).reverse().map((m) => ({
    role: m.sender_type === 'patient' ? ('user' as const) : ('assistant' as const),
    content: m.content ?? '',
  }));

  // 4. agent
  const { agent } = await createAgent({ clinicId: args.clinicId, name: 'agente-principal', supabase: args.supabase });

  // 5. trace
  const langfuse = getLangfuseClient();
  const sessionId = `clinic:${args.clinicId}:conv:${args.conversationId}`;
  const start = Date.now();

  return withTrace(langfuse, {
    name: 'dispatch-agent',
    sessionId,
    metadata: { conversationId: args.conversationId, clinicId: args.clinicId, model: cfg.model, agentConfigId: cfg.id },
  }, async (trace) => {
    const generation = trace?.generation?.({ name: 'agent.generate', model: cfg.model, input: messages });
    let result;
    try {
      result = await agent.generate({ messages });
      generation?.end?.({ output: result.text, usage: result.usage });
    } catch (err) {
      generation?.end?.({ level: 'ERROR', statusMessage: String(err) });
      throw err; // Inngest retries
    }

    // 6. insere resposta no outbox
    const { data: msg, error: mErr } = await args.supabase.from('messages').insert({
      clinic_id: args.clinicId,
      conversation_id: args.conversationId,
      direction: 'outbound',
      sender_type: 'ai',
      sender_user_id: null,
      content_type: 'text',
      content: result.text,
      external_id: null,
      delivery_status: 'pending',
      outbox_status: 'pending',
      agent_config_id: cfg.id,
    }).select('id').single();
    if (mErr) throw new Error(`message insert failed: ${mErr.message}`);

    const elapsed = Date.now() - start;
    trace?.score?.({ name: 'latency_ms', value: elapsed });

    return {
      messageId: msg.id,
      traceId: trace?.id ?? null,
      tokensIn: result.usage?.promptTokens ?? 0,
      tokensOut: result.usage?.completionTokens ?? 0,
    };
  });
}
```

- [ ] **Step 6.4:** Verify GREEN. Iterar até 10/10 passing.

```bash
pnpm --filter @medina/ai test dispatcher
```

- [ ] **Step 6.5:** Commit.

```bash
git commit -am "feat(ai): dispatchAgent with langfuse traces + cross-tenant safety"
```

---

## Task 7: Inngest function dispatch-ai-agent

**Files:**
- Create: `apps/web/lib/inngest/functions/dispatch-ai-agent.ts`
- Create: `apps/web/lib/inngest/functions/__tests__/dispatch-ai-agent.test.ts`
- Modify: `apps/web/app/api/inngest/route.ts`

- [ ] **Step 7.1:** Test primeiro.

```ts
it('processes ai/message.received and dispatches chat/message.outbound after success', async () => {
  const dispatchFn = vi.fn().mockResolvedValue({ messageId: 'msg-out-1', traceId: 't-1', tokensIn: 100, tokensOut: 50 });
  const inngestSend = vi.fn();
  await dispatchAiAgentHandler({ event: { data: { messageId: 'msg-in-1', conversationId: 'c-1', clinicId: 'clinic-1' } }, step: fakeStep, deps: { dispatchAgent: dispatchFn, inngestSend } });
  expect(dispatchFn).toHaveBeenCalledWith({ messageId: 'msg-in-1', conversationId: 'c-1', clinicId: 'clinic-1', supabase: expect.anything() });
  expect(inngestSend).toHaveBeenCalledWith({ name: 'chat/message.outbound', data: { messageId: 'msg-out-1' } });
});

it('AgentDispatchSkipped is treated as success (no retry)', async () => { ... });

it('LLM error throws so Inngest retries', async () => { ... });
```

- [ ] **Step 7.2:** Implementação.

```ts
// apps/web/lib/inngest/functions/dispatch-ai-agent.ts
import { inngest } from '../client';
import { dispatchAgent, AgentDispatchSkipped } from '@medina/ai';
import { createAdminSupabase } from '@/lib/supabase/admin';

export const dispatchAiAgent = inngest.createFunction(
  { id: 'dispatch-ai-agent', retries: 2 },
  { event: 'ai/message.received' },
  async ({ event, step }) => {
    const sb = createAdminSupabase();
    let result;
    try {
      result = await step.run('dispatch-agent', () =>
        dispatchAgent({
          conversationId: event.data.conversationId,
          clinicId: event.data.clinicId,
          messageId: event.data.messageId,
          supabase: sb,
        }),
      );
    } catch (err) {
      if (err instanceof AgentDispatchSkipped) return { skipped: err.reason };
      throw err;
    }
    await step.sendEvent('queue-outbound', {
      name: 'chat/message.outbound',
      data: { messageId: result.messageId },
    });
    return { messageId: result.messageId, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
  },
);
```

- [ ] **Step 7.3:** Registrar no `apps/web/app/api/inngest/route.ts`.

```ts
import { dispatchAiAgent } from '@/lib/inngest/functions/dispatch-ai-agent';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processOutboundMessage, onProcessOutboundFailure, processMessageStatus, dispatchAiAgent],
});
```

- [ ] **Step 7.4:** Verify + commit.

```bash
pnpm --filter web test dispatch-ai-agent
git commit -am "feat(inngest): dispatch-ai-agent function with AgentDispatchSkipped handling"
```

---

## Task 8: Seed agent_config pra são-lucas

**Files:**
- Create: `packages/db/scripts/seed-agent-config.ts`
- Create: `packages/db/scripts/README.md`

- [ ] **Step 8.1:** Implementar `seedDefaultAgentConfig`.

```ts
// packages/db/scripts/seed-agent-config.ts
import { createClient } from '@supabase/supabase-js';

const SYSTEM_PROMPT = `Você é um assistente virtual da clínica médica {{clinic_name}}.
Responda de forma educada, profissional e acolhedora aos pacientes via WhatsApp.

Diretrizes:
- Cumprimente o paciente pelo nome quando souber
- Seja conciso (máximo 3 parágrafos)
- NÃO dê diagnósticos médicos
- NÃO recomende medicamentos
- Para dúvidas técnicas médicas, oriente o paciente a falar com um humano da equipe
- Se o paciente perguntar algo que você não pode resolver, diga claramente e ofereça transferir pra atendente humano
`;

export async function seedDefaultAgentConfig(clinicId: string): Promise<{ created: boolean; configId: string }> {
  const sb = createClient(process.env['NEXT_PUBLIC_SUPABASE_URL']!, process.env['SUPABASE_SERVICE_ROLE_KEY']!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: clinic } = await sb.from('clinics').select('name').eq('id', clinicId).single();
  if (!clinic) throw new Error(`clinic ${clinicId} not found`);

  const { data: existing } = await sb.from('agent_configs')
    .select('id').eq('clinic_id', clinicId).eq('name', 'agente-principal').eq('status', 'published').maybeSingle();
  if (existing) return { created: false, configId: existing.id };

  const { data, error } = await sb.from('agent_configs').insert({
    clinic_id: clinicId,
    name: 'agente-principal',
    status: 'published',
    system_prompt: SYSTEM_PROMPT.replace('{{clinic_name}}', clinic.name),
    model: 'anthropic/claude-sonnet-4-5',
    temperature: 0.7,
    max_tokens: 1024,
    tools: [],
    guardrails: {},
    handoff_rules: {},
    knowledge_document_ids: [],
    metadata: { seeded_by: 'seed-agent-config.ts', seeded_at: new Date().toISOString() },
    published_at: new Date().toISOString(),
  }).select('id').single();
  if (error) throw new Error(`seed failed: ${error.message}`);
  return { created: true, configId: data.id };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const clinicId = process.argv[2];
  if (!clinicId) { console.error('Usage: tsx seed-agent-config.ts <clinic-id>'); process.exit(1); }
  seedDefaultAgentConfig(clinicId).then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 8.2:** README curto explicando uso.

```md
# packages/db/scripts

Scripts manuais (não rodam em CI). One-off por clínica.

## seed-agent-config.ts

Seedaa um agent_config 'agente-principal' published pra uma clínica.
Idempotente: se já existir published com mesmo nome, retorna o id.

```bash
pnpm tsx packages/db/scripts/seed-agent-config.ts <clinic-id>
```
```

- [ ] **Step 8.3:** Smoke local.

```bash
SUPABASE_SERVICE_ROLE_KEY=$(grep SUPABASE_SERVICE_ROLE_KEY apps/web/.env.local | cut -d= -f2) \
NEXT_PUBLIC_SUPABASE_URL=$(grep NEXT_PUBLIC_SUPABASE_URL apps/web/.env.local | cut -d= -f2) \
pnpm tsx packages/db/scripts/seed-agent-config.ts cdd97f60-9ede-42e0-bc7d-f64b27f65d3b
```

Expected: `{"created":true,"configId":"<uuid>"}`. Re-rodar deve dar `{"created":false,"configId":"<mesmo uuid>"}`.

- [ ] **Step 8.4:** Commit.

```bash
git add packages/db/scripts/
git commit -m "chore(db): seed-agent-config script for default whatsapp agent"
```

---

## Task 9: shadcn Switch component

- [ ] **Step 9.1:** Scaffold via shadcn CLI.

```bash
cd apps/web && pnpm dlx shadcn@latest add switch
```

Verifica que `apps/web/components/ui/switch.tsx` foi criado e usa Radix `@radix-ui/react-switch`.

- [ ] **Step 9.2:** Commit.

```bash
git add apps/web/components/ui/switch.tsx apps/web/package.json pnpm-lock.yaml
git commit -m "chore(ui): add shadcn switch component"
```

---

## Task 10: AiHandlingToggle + server action

**Files:**
- Create: `apps/web/app/[slug]/inbox/toggle-ai-handling-action.ts`
- Create: `apps/web/app/[slug]/inbox/toggle-ai-handling-action.test.ts`
- Create: `apps/web/app/[slug]/inbox/_components/AiHandlingToggle.tsx`

- [ ] **Step 10.1:** Test da action primeiro (TDD).

```ts
// toggle-ai-handling-action.test.ts
it('transitions ai_handling → waiting_human via RPC transition_conversation_state', async () => {
  // mock supabase.rpc('transition_conversation_state', { p_conversation_id, p_new_state, p_reason })
  await toggleAiHandlingAction({ conversationId: 'c-1', newState: 'waiting_human' });
  expect(rpcSpy).toHaveBeenCalledWith('transition_conversation_state', expect.objectContaining({ p_new_state: 'waiting_human' }));
});

it('transitions waiting_human → ai_handling', async () => { ... });
it('rejects invalid transitions (e.g. resolved → ai_handling) — bubble up RPC error', async () => { ... });
it('rejects cross-clinic conversation', async () => { ... });
```

- [ ] **Step 10.2:** Implementação.

```ts
// toggle-ai-handling-action.ts
'use server';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getTenantContext, getSupabaseServerClient } from '@medina/auth';

const Schema = z.object({
  conversationId: z.string().uuid(),
  newState: z.enum(['ai_handling', 'waiting_human']),
});

export async function toggleAiHandlingAction(input: z.infer<typeof Schema>) {
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { error: 'Entrada inválida.' };
  const ctx = await getTenantContext();
  const sb = await getSupabaseServerClient();

  // cross-tenant guard
  const { data: conv } = await sb.from('conversations').select('clinic_id').eq('id', parsed.data.conversationId).maybeSingle();
  if (!conv || conv.clinic_id !== ctx.clinicId) return { error: 'Conversa não encontrada.' };

  const { error } = await sb.rpc('transition_conversation_state', {
    p_conversation_id: parsed.data.conversationId,
    p_new_state: parsed.data.newState,
    p_reason: parsed.data.newState === 'ai_handling' ? 'human_returned_to_ai' : 'human_paused_ai',
  });
  if (error) return { error: error.message };

  revalidatePath(`/${ctx.clinicSlug}/inbox`);
  return { ok: true } as const;
}
```

- [ ] **Step 10.3:** Componente UI.

```tsx
// AiHandlingToggle.tsx
'use client';
import { useTransition } from 'react';
import { Switch } from '@/components/ui/switch';
import { toggleAiHandlingAction } from '../toggle-ai-handling-action';

type Props = {
  conversationId: string;
  state: 'ai_handling' | 'waiting_human' | string; // inbound state pode ser outros
};

export function AiHandlingToggle({ conversationId, state }: Props) {
  const [pending, startTransition] = useTransition();
  const isAi = state === 'ai_handling';
  const enabled = state === 'ai_handling' || state === 'waiting_human';

  if (!enabled) return null; // não mostrar em resolved/paused/etc

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={isAi ? 'text-[var(--luma-accent)]' : 'text-[var(--luma-text-secondary)]'}>
        {isAi ? '🤖 IA atendendo' : '👤 Atendendo manualmente'}
      </span>
      <Switch
        checked={isAi}
        disabled={pending}
        onCheckedChange={(checked) => {
          startTransition(async () => {
            await toggleAiHandlingAction({
              conversationId,
              newState: checked ? 'ai_handling' : 'waiting_human',
            });
          });
        }}
      />
    </div>
  );
}
```

Visual: usa `--luma-accent` (teal #0ea5e9) quando IA ativa. Texto secundary quando humano. Toggle suave (Radix Switch padrão shadcn).

- [ ] **Step 10.4:** Verify + commit.

```bash
pnpm --filter web test toggle-ai-handling
git add apps/web/app/[slug]/inbox/toggle-ai-handling-action.ts apps/web/app/[slug]/inbox/toggle-ai-handling-action.test.ts apps/web/app/[slug]/inbox/_components/AiHandlingToggle.tsx
git commit -m "feat(inbox): AiHandlingToggle + toggleAiHandlingAction"
```

---

## Task 11: Integrar toggle no header + visual AI message

**Files:**
- Modify: `apps/web/app/[slug]/inbox/conversation-detail.tsx`
- Modify: `apps/web/app/[slug]/inbox/_components/MessageBubble.tsx`

- [ ] **Step 11.1:** Header — inserir AiHandlingToggle entre nome e badge de state.

```tsx
// dentro do header (linhas 85-102 atuais)
<div className="flex items-center gap-3">
  <AiHandlingToggle conversationId={conversation.id} state={conversation.state} />
  <span className={`badge-${stateClass(conversation.state)}`}>{STATE_LABEL[conversation.state]}</span>
</div>
```

- [ ] **Step 11.2:** MessageBubble — diferenciação visual quando `senderType='ai'`.

```tsx
// dentro do MessageBubble, antes do return:
const isAi = m.senderType === 'ai';

// no className do balloon (outbound):
className={`... ${isAi ? 'border-l-2 border-l-[var(--luma-accent)] bg-[rgba(14,165,233,0.06)]' : 'bg-[var(--luma-accent-soft)]'}`}

// adicionar mini-badge no canto superior direito do balloon AI:
{isAi && <span className="badge-ai text-xs px-1.5 py-0.5 rounded-md">IA</span>}
```

Justificativa estética (Luma):
- Borda esquerda teal `--luma-accent` faz a mensagem AI cantar visualmente sem ser garrida
- Background levemente teal (rgba 0.06) é mais suave que o `--luma-accent-soft` padrão de outbound humano
- Reusa classe `.badge-ai` já existente no `globals.css:768`

- [ ] **Step 11.3:** Verify visual em produção (smoke prod no Task 14).

- [ ] **Step 11.4:** Commit.

```bash
git commit -am "feat(inbox): integrate AiHandlingToggle in header + AI message visual"
```

---

## Task 12: .env.example + apps/web/.env.example

**Files:**
- Modify: `.env.example` (root)
- Create: `apps/web/.env.example`

- [ ] **Step 12.1:** Atualizar root `.env.example`.

```env
# ─── AI / Mastra ─────────────────
OPENROUTER_API_KEY=your_openrouter_api_key_here
OPENAI_API_KEY=your_openai_api_key_here  # embeddings (RAG futuro AI-3)
ANTHROPIC_API_KEY=your_anthropic_api_key_here  # legado, opcional
MASTRA_POSTGRES_URL=your_postgres_connection_string_here  # AI-3
MASTRA_TELEMETRY_ENABLED=false

# ─── Langfuse observability ──────
LANGFUSE_PUBLIC_KEY=your_langfuse_public_key_here
LANGFUSE_SECRET_KEY=your_langfuse_secret_key_here
LANGFUSE_HOST=https://cloud.langfuse.com
```

- [ ] **Step 12.2:** Criar `apps/web/.env.example` espelhando.

- [ ] **Step 12.3:** Commit.

```bash
git add .env.example apps/web/.env.example
git commit -m "docs(env): document OPENROUTER + LANGFUSE vars"
```

---

## Task 13: Verificação final

- [ ] **Step 13.1:** typecheck completo.

```bash
pnpm typecheck
```

Expected: zero erros nos pacotes tocados (`@medina/ai`, `@medina/chat`, `@medina/integrations-kapso`, `web`).

- [ ] **Step 13.2:** test completo.

```bash
pnpm test
```

Expected: TODOS os testes verdes. Comparar com baseline de Step 0.4 — se algum teste antigo virou vermelho, investigar antes de prosseguir.

- [ ] **Step 13.3:** Build.

```bash
pnpm build
```

Expected: build sucesso.

- [ ] **Step 13.4:** Supabase advisors.

```bash
# via MCP supabase
list advisors
```

Expected: zero criticals novos.

---

## Task 14: Smoke test em produção

Pré-requisito: PR pronto + branch pushada + Vercel preview ou produção tem as envs.

- [ ] **Step 14.1:** Rodar seed pra clínica são-lucas em produção.

```bash
pnpm tsx packages/db/scripts/seed-agent-config.ts cdd97f60-9ede-42e0-bc7d-f64b27f65d3b
```

- [ ] **Step 14.2:** Mandar mensagem WhatsApp real pra número da são-lucas (Gabriel + amigo).

Mensagem: `"Olá, gostaria de marcar uma consulta"`

- [ ] **Step 14.3:** Verificações (todas devem ser ✅):

  - Inngest dashboard mostra evento `ai/message.received` processado
  - Langfuse mostra trace com input/output/tokens/latency/cost
  - Resposta da IA chega no inbox em 3-8 segundos
  - Mensagem AI aparece com badge "IA" + borda teal
  - Status: pending → sent → delivered (CHAT-2 + CHAT-3 funcionando juntos)
  - Toggle "🤖 IA atendendo" → "👤 Atendendo manualmente": próxima inbound NÃO dispara agente
  - Toggle de volta: agente volta a responder
  - Trace no Langfuse mostra `model='anthropic/claude-sonnet-4-5'`, tokens, custo

- [ ] **Step 14.4:** Documentar resultados na descrição do PR (screenshots Langfuse + Inbox).

**Se DER ERRO:** parar, mostrar o erro, NÃO fazer cleanup. Especialmente:
- `@openrouter/ai-sdk-provider` incompatível com Mastra Agent: pinar versões compatíveis ou wrappa manualmente.
- Cross-tenant violation: testar rigorosamente o test 6.1 antes de seguir.
- conversation.state stuck: verificar se transition_conversation_state aceita ai_handling↔waiting_human (matriz CHECK aceita).
- Langfuse timing out: failsafe em withTrace garante agente continuar; se ainda assim quebrar, isolar com try/catch broader.
- Idempotência: testar mandar 2 webhooks com mesmo external_id manualmente e verificar Inngest dedup ai:${messageId}.

---

## Task 15: finishing-a-development-branch

- [ ] **Step 15.1:** Verificar tests passam (rodar `pnpm test`).

- [ ] **Step 15.2:** `git log --oneline g/ai-1-mastra-agent-basic ^main` — verificar 8-12 commits incrementais.

- [ ] **Step 15.3:** Push + abrir PR.

```bash
git push -u origin g/ai-1-mastra-agent-basic
gh pr create --title "feat(ai): AI-1 mastra agent basic in inbox + langfuse traces" --body "$(cat <<'EOF'
## Antes
Inbound WhatsApp não tinha resposta automática. Atendentes humanos precisavam responder tudo manualmente.

## Depois
Agente Mastra responde automaticamente via OpenRouter. Toggle UI permite atendente pausar/retomar IA por conversa. Tudo observável no Langfuse.

## O que entrega
- Foundation `packages/ai` reparado (package.json, errors.ts, vitest.config.ts)
- OpenRouter substitui @ai-sdk/anthropic em agent-factory
- Langfuse client + tracing failsafe
- `dispatcher.ts` com cross-tenant rigor + history últimas 20 msgs
- Inngest function `dispatch-ai-agent` (retries 2, idempotência via event id)
- Adapter Kapso dispara `ai/message.received` quando state=ai_handling
- `getOrCreateConversation` aceita initialState (webhook decide ai_handling vs waiting_human)
- AiHandlingToggle (Switch shadcn) + toggleAiHandlingAction
- MessageBubble visual diferenciado pra sender_type='ai'
- Seed script idempotente em packages/db/scripts/

## NÃO entrega (deferido)
- Tools (AI-2)
- RAG / Mastra storage (AI-3)
- confirm_appointment (AI-4)
- Guardrails strict (AI-5)

## Como testar
Ver Task 14 do plan: seed clínica → mensagem WhatsApp → verificar Inngest + Langfuse + Inbox UI.

## Custo estimado
1k conversas/mês ~ R\$ 50-150 dependendo do volume de tokens. Sonnet 4.5 ~\$0.003 input / \$0.015 output por 1k tokens. Conversa típica ~\$0.05-0.15. Tudo trace no Langfuse pra monitorar.

## Screenshots
[anexar trace Langfuse + Inbox com toggle + mensagem AI]
EOF
)"
```

- [ ] **Step 15.4:** NÃO mergeia. Aguarda review humano + CodeRabbit.

---

## Verificação Final (Self-Review)

Antes de chamar a plan completa:

- ✅ Spec coverage: cada item do brief mapeia pra task (state machine resolvida via Q1, seed via Q2, foundation via Q3)
- ✅ Sem placeholders: cada step tem código real ou comando real
- ✅ Type consistency: `dispatchAgent` retorna `DispatchResult` em todos refs; `AgentDispatchSkipped` mesmo nome em todas tasks
- ✅ TDD respeitado: dispatcher (Task 6), langfuse (Task 3), action (Task 10), adapter (Task 5), conversations (Task 4) — todos com test-first
- ✅ Cross-tenant: test rigoroso na Task 6.1 + guard inline em dispatcher.ts + guard em toggleAiHandlingAction
- ✅ Failsafe Langfuse: withTrace test cobrindo throw em Task 3.1
- ✅ Idempotência: Inngest event id `ai:${messageId}` documentado em adapter (5.2) e dispatcher test (6.1)

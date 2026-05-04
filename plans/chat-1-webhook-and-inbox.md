# CHAT-1: Webhook Kapso receiver + Inbox UI básica

> **Branch:** `g/chat-1-webhook-and-inbox` em worktree `.worktrees/chat-1`.
> **Sub-skill execution:** `superpowers:subagent-driven-development` ou `executing-plans`.

## Context

Vault encryption mergeada (`f1761e2`). Row Kapso real existe em `clinic_integrations` (clínica `2fa85492-…`) com `api_key` + `workspace_id` decriptáveis via `get_integration_credential`. Webhook configurado pra ngrok local. Falta: receber payload Kapso → persistir conversa+mensagem → UI inbox funcional → atendente envia mensagem manual via Kapso API.

**Não entrega nesta sprint:** realtime (CHAT-2), outbox+Inngest (CHAT-2), agente IA (CHAT-3+), anexos (CHAT-4).

## Decisões locked

1. **`signatureHeader`** corrigido de `x-kapso-signature` → `x-webhook-signature` (Kapso real). Sem prefixo `sha256=`. Verifier existente já compatível.
2. **`phone_number_id`** lazy-capture do webhook inbound → grava em `clinic_integrations.config.phone_number_id` no primeiro recebimento.
3. **`conversations.external_id`** = phone E.164 do paciente. Uma conversa contínua por (clinic, integration, phone).
4. **`sendMessageAction` em erro Kapso:** falha sync, `{error}`, sem INSERT, toast vermelho.
5. **Tipos não-suportados** (image/audio/video/document/sticker/location): INSERT com `content_type` real + `content = '[Anexo não exibido — suporte em CHAT-4]'`.
6. **`@medina/chat`** package novo. Helpers tomam `SupabaseClient` injetado. Webhook usa admin (service-role); UI usa server (cookies).
7. **Sem migration nova.** Schema 0005/0006 cobre. `delivery_status` updates via admin client (UPDATE permitido pra service_role).
8. **`date-fns`** + locale `pt-BR` pra relative time.
9. **Domain types** (`InboundMessageEvent`, `StatusUpdateEvent`) ficam em `@medina/chat/src/types.ts`. Kapso depende de chat (uni-direcional).

## File structure

**Novos:**
- `packages/integrations/whatsapp/kapso/src/{types.ts, parse.ts}` + tests
- `packages/integrations/whatsapp/kapso/src/adapter.ts` (rewrite)
- `packages/integrations/whatsapp/kapso/tests/{parse, adapter}.test.ts`
- `packages/chat/{package.json, tsconfig.json, vitest.config.ts}`
- `packages/chat/src/{index, types, patients, conversations, inbox}.ts`
- `packages/chat/tests/{helpers, patients, conversations, inbox}.test.ts`
- `apps/web/app/[slug]/inbox/{actions, conversation-list, conversation-detail, send-message-form, empty-state, relative-time, conversation-avatar}.tsx|ts`
- `apps/web/app/[slug]/inbox/actions.test.ts`

**Modificados:**
- `apps/web/app/api/webhooks/[type]/[provider]/[clinicId]/route.ts` (registra adapters)
- `apps/web/app/[slug]/inbox/page.tsx` (rewrite stub)
- `apps/web/package.json` (+ `date-fns: ^4`)
- `packages/integrations/whatsapp/kapso/package.json` (+ `@medina/chat`, `@supabase/supabase-js`, `zod`)

---

## Tasks

### Task 1: Worktree + baseline

- [ ] `git check-ignore -q .worktrees` → se MISSING, adicionar ao `.gitignore` em commit separado em main antes de continuar.
- [ ] `git worktree add .worktrees/chat-1 -b g/chat-1-webhook-and-inbox` + `pnpm install` no worktree.
- [ ] `pnpm --filter @medina/db test` → 96 verde (baseline). Se falhar, parar.

### Task 2: Kapso payload Zod schemas

**File:** `packages/integrations/whatsapp/kapso/src/types.ts`

- [ ] **RED:** `tests/parse.test.ts` com 2 assertions:
  - "validates inbound text payload" (sample: `{ type: 'whatsapp.message.received', data: { phone_number_id, message: { id, from, type:'text', timestamp, text:{body}, kapso:{direction:'inbound', status:'received', statuses:[]} }, conversation: {...} } }`)
  - "rejects payload without `type`"
- [ ] Verify FAIL.
- [ ] **GREEN:** Zod schema com `KapsoMessageSchema`, `KapsoMessageDataSchema`, `KapsoWebhookPayloadSchema`. Campos: `type` (string), `data.phone_number_id` (string), `data.message.{id, type:enum, from?, to?, timestamp, text?:{body}, kapso:{direction, status, statuses[]}, errors?[]}`, `data.conversation?.{id, phone_number?}`. `test?:bool` opcional. Export type `KapsoWebhookPayload`.
- [ ] Commit: `feat(integrations-kapso): zod schemas for webhook payloads`

### Task 3: Pure parse functions

**File:** `packages/integrations/whatsapp/kapso/src/parse.ts`

> **Dep direction:** `InboundMessageEvent`/`StatusUpdateEvent` ficam em `@medina/chat`. Kapso importa de chat (uni-direcional). Evita circular.

- [ ] **RED:** Tests:
  - `parseInboundMessage` → retorna `InboundMessageEvent` canônico pra type=text
  - `parseInboundMessage` → tipos não-text retornam contentType real + content = `'[Anexo não exibido — suporte em CHAT-4]'`
  - `parseInboundMessage` → retorna null se type não é `whatsapp.message.received`
  - `parseStatusUpdate` → mapeia `whatsapp.message.{sent,delivered,read,failed}` pra status enum
  - `parseStatusUpdate` → extrai `errors[0].message` como `deliveryError` em failed
  - `extractPhoneNumberId` → lê `data.phone_number_id`
- [ ] Verify FAIL (chat package ainda não existe → import fails). Pular essa task até Task 4 estar pronta, OU criar stub temporário em chat agora. Decisão: rodar Task 4 antes do GREEN da Task 3.

### Task 4: @medina/chat scaffold + types

**Files:** `packages/chat/{package.json, tsconfig.json, vitest.config.ts, src/index.ts, src/types.ts}`

- [ ] `package.json`:
  ```json
  {
    "name": "@medina/chat", "version": "0.0.1", "private": true, "type": "module",
    "exports": {".": "./src/index.ts"},
    "scripts": {"typecheck": "tsc --noEmit", "test": "vitest run"},
    "dependencies": {"@medina/db": "workspace:*", "@supabase/supabase-js": "^2", "zod": "^3"},
    "devDependencies": {"@types/node": "^22", "typescript": "^5", "vitest": "^3.1.3", "postgres": "^3.4.5", "dotenv": "^16.4.7"}
  }
  ```
- [ ] `vitest.config.ts`: mirror `packages/db/vitest.config.ts` (pool=forks, singleFork=true, hookTimeout=30000, testTimeout=30000).
- [ ] `src/types.ts`:
  ```typescript
  import type { Conversation, Message, Patient } from '@medina/db';

  export type InboundMessageEvent = {
    kind: 'inbound_message';
    externalMessageId: string; fromPhone: string;
    contentType: 'text' | 'image' | 'audio' | 'video' | 'document' | 'system';
    content: string; receivedAt: Date;
    phoneNumberId: string; kapsoConversationId: string | undefined;
  };
  export type StatusUpdateEvent = {
    kind: 'status_update'; externalMessageId: string;
    status: 'sent' | 'delivered' | 'read' | 'failed';
    deliveryError: string | undefined;
  };
  export type ConversationListItem = Pick<Conversation,
    'id'|'state'|'lastMessageAt'|'lastMessagePreview'|'unreadCount'|'externalId'|'patientId'>
    & { patientName: string | null };
  export type ConversationWithMessages = Conversation & {
    patient: Pick<Patient, 'id'|'fullName'|'phone'|'preferredName'> | null;
    messages: Message[];
  };
  ```
- [ ] `src/index.ts` re-exports types + (futuras) functions.
- [ ] `pnpm install` na raiz pra registrar workspace.
- [ ] Commit: `chore(chat): scaffold @medina/chat package`

### Task 3 (resumed): GREEN parse.ts

- [ ] Implement `parse.ts` importando types de `@medina/chat`. Funções:
  ```typescript
  export function parseInboundMessage(raw: unknown): InboundMessageEvent | null
  export function parseStatusUpdate(raw: unknown): StatusUpdateEvent | null
  export function extractPhoneNumberId(raw: unknown): string | null
  ```
  Lógica: zod safeParse → se sucesso e `type==='whatsapp.message.received'` → mapear pra InboundMessageEvent. `timestamp` é string → `new Date(Number(ts) * 1000)`. Tipos suportados em DB: `text|image|audio|video|document`; outros caem em `'system'`. Content: se text e `text.body`, usar; senão placeholder.
- [ ] Verify GREEN.
- [ ] Commit: `feat(integrations-kapso): pure parse functions for inbound and status events`

### Task 5: lookupOrCreatePatientByPhone (TDD)

**File:** `packages/chat/src/patients.ts` + `tests/patients.test.ts`

- [ ] **RED:** Tests (postgres-js client, helper local replicando `createTestClinic`/`createTestPatient` de `packages/db/tests/rls/helpers/setup.ts`):
  - `it('returns existing patient when phone matches in clinic')`
  - `it('creates patient with source=whatsapp + full_name=phone when missing')`
  - `it('respects clinic_id isolation: same phone in clinic B does not match clinic A')`
- [ ] **GREEN:** function signature `lookupOrCreatePatientByPhone(sb: SupabaseClient, clinicId: string, phoneE164: string): Promise<{ patient: Patient; created: boolean }>`. Lógica: SELECT por (clinic_id, phone, deleted_at IS NULL) → se existe retornar; senão INSERT com `{ clinic_id, phone, full_name: phone, source: 'whatsapp' }` → retornar `created: true`.
- [ ] Commit: `feat(chat): lookupOrCreatePatientByPhone helper`

### Task 6: Conversations + messages helpers (TDD)

**File:** `packages/chat/src/conversations.ts` + `tests/conversations.test.ts`

- [ ] **RED:** Tests:
  - `getOrCreateConversation` cria na primeira chamada; idempotente em (clinic_id, integration_id, external_id) na segunda
  - `addMessage` insere inbound; trigger `update_conversation_on_message` atualiza `last_message_at + unread_count`
  - `addMessage` com mesmo `external_id` retorna existing message (created=false) — idempotência Kapso retry
  - `updateMessageDeliveryStatus` atualiza row por (clinic_id, external_id); retorna `{updated:false}` se row não existe
  - `addMessage` outbound → `unread_count` zera (trigger nativo)
- [ ] **GREEN:** signatures:
  ```typescript
  export type GetOrCreateConversationArgs = { clinicId: string; integrationId: string; channel: 'whatsapp'; externalId: string; patientId: string | null };
  export async function getOrCreateConversation(sb: SupabaseClient, a: GetOrCreateConversationArgs): Promise<{ conversation: Conversation; created: boolean }>;

  export type AddMessageArgs = {
    clinicId: string; conversationId: string;
    direction: 'inbound'|'outbound'; senderType: 'patient'|'human'|'ai'|'system';
    senderUserId: string | null; contentType: Message['contentType'];
    content: string | null; externalId: string | null; deliveryStatus?: Message['deliveryStatus'];
  };
  export async function addMessage(sb: SupabaseClient, a: AddMessageArgs): Promise<{ message: Message; created: boolean }>;

  export async function updateMessageDeliveryStatus(sb: SupabaseClient, clinicId: string, evt: StatusUpdateEvent): Promise<{ updated: boolean }>;
  ```
  - `getOrCreateConversation`: SELECT primeiro; se miss, INSERT com `state: 'waiting_human'` (atendimento humano default em CHAT-1).
  - `addMessage` se `externalId` setado: SELECT por (clinic_id, external_id) primeiro; se hit retorna sem INSERT.
  - `updateMessageDeliveryStatus`: UPDATE com WHERE (clinic_id, external_id), retorna `updated: rows.length > 0`.
- [ ] Commit: `feat(chat): getOrCreateConversation + addMessage + updateMessageDeliveryStatus`

### Task 7: Inbox query helpers (TDD)

**File:** `packages/chat/src/inbox.ts` + `tests/inbox.test.ts`

- [ ] **RED:** Tests:
  - `listConversations` retorna conversas da clínica ordenadas por `last_message_at desc nulls last`
  - `listConversations` exclui `state='resolved'` por default; opção `includeResolved=true` reverte
  - `listConversations` filtra por `assignedUserId` quando setado
  - `listConversations` cross-tenant: clinic A não vê clinic B
  - `getConversationWithMessages` retorna messages ordenadas `created_at asc` + JOIN com patient
- [ ] **GREEN:** signatures:
  ```typescript
  export type ListConversationsArgs = { includeResolved?: boolean; assignedUserId?: string };
  export async function listConversations(sb: SupabaseClient, clinicId: string, args?: ListConversationsArgs): Promise<ConversationListItem[]>;
  export async function getConversationWithMessages(sb: SupabaseClient, clinicId: string, conversationId: string): Promise<ConversationWithMessages | null>;
  ```
  Implementação:  `.select('id, state, last_message_at, last_message_preview, unread_count, external_id, patient_id, patient:patients(full_name)')` com `.eq('clinic_id', clinicId).is('deleted_at', null)`. Map `patient.full_name` pra `patientName`.
- [ ] Commit: `feat(chat): listConversations + getConversationWithMessages`

### Task 8: Adapter (TDD) — orquestra parse → @medina/chat

**File:** `packages/integrations/whatsapp/kapso/src/adapter.ts` (rewrite) + `tests/adapter.test.ts`

> **Mocking:** tests usam `vi.mock('@medina/chat')` retornando stubs determinísticos. Helpers já têm integration tests contra DB real (Tasks 5-7). Adapter foco: parse correto → dispatch correto.

- [ ] **RED:** Tests (9):
  - `signatureHeader === 'x-webhook-signature'` (regression guard)
  - inbound text → cria conversation + message (uma chamada cada helper)
  - idempotente: mesma external_id 2× → addMessage retorna `created:false` na segunda
  - cria patient quando phone unknown
  - linka a patient existente quando phone match
  - tipo não-suportado → INSERT com `content_type='image'` + content placeholder
  - `whatsapp.message.delivered` → updateMessageDeliveryStatus chamado, returna `processed:true`
  - captura `phone_number_id` em `clinic_integrations.config` no primeiro inbound (UPDATE)
  - retorna `processed:false, reason:'unhandled_event'` pra `whatsapp.conversation.created` (irrelevante)
- [ ] **GREEN:**
  ```typescript
  export const kapsoAdapter: AdapterInterface = {
    type: 'whatsapp', provider: 'kapso',
    signatureHeader: 'x-webhook-signature',
    async handle(ctx) {
      const sb = makeAdminSupabase();
      const inbound = parseInboundMessage(ctx.payload);
      if (inbound) {
        const { patient } = await lookupOrCreatePatientByPhone(sb, ctx.clinicId, inbound.fromPhone);
        const { conversation } = await getOrCreateConversation(sb, {
          clinicId: ctx.clinicId, integrationId: ctx.integration.id, channel: 'whatsapp',
          externalId: inbound.fromPhone, patientId: patient.id,
        });
        const { created } = await addMessage(sb, {
          clinicId: ctx.clinicId, conversationId: conversation.id,
          direction: 'inbound', senderType: 'patient', senderUserId: null,
          contentType: inbound.contentType, content: inbound.content,
          externalId: inbound.externalMessageId, deliveryStatus: 'delivered',
        });
        const cfg = (ctx.integration.config ?? {}) as Record<string, unknown>;
        if (cfg['phone_number_id'] !== inbound.phoneNumberId) {
          await sb.from('clinic_integrations').update({ config: { ...cfg, phone_number_id: inbound.phoneNumberId } }).eq('id', ctx.integration.id);
        }
        return { processed: true, reason: created ? 'message_inserted' : 'duplicate_idempotent' };
      }
      const status = parseStatusUpdate(ctx.payload);
      if (status) {
        const { updated } = await updateMessageDeliveryStatus(sb, ctx.clinicId, status);
        return { processed: updated, reason: updated ? 'status_updated' : 'message_not_found' };
      }
      return { processed: false, reason: 'unhandled_event' };
    },
    async healthCheck() { return { healthy: true, message: 'kapso adapter ready' }; },
  };
  ```
- [ ] Commit: `feat(integrations-kapso): real adapter handle for inbound + status events`

### Task 9: Registrar adapter na route

**File:** `apps/web/app/api/webhooks/[type]/[provider]/[clinicId]/route.ts`

- [ ] Modify: importar `kapsoAdapter`, `calcomAdapter`, `registry` no top-level e chamar `registry.register(...)` antes do export. Idempotente em HMR (Map.set overwrite).
- [ ] Smoke manual: `pnpm dev` + ngrok ativo → enviar mensagem de teste via WhatsApp → conferir log JSON com `action:'handle', success:true` no console + `SELECT * FROM messages ORDER BY created_at DESC LIMIT 1` mostrando row.
- [ ] Commit: `feat(web): register kapso + calcom adapters in webhook route`

### Task 10: Inbox page server component shell

**File:** `apps/web/app/[slug]/inbox/page.tsx` (rewrite) + `empty-state.tsx`

- [ ] `page.tsx`:
  ```tsx
  import { getTenantContext, getSupabaseServerClient } from '@medina/auth';
  import { listConversations, getConversationWithMessages } from '@medina/chat';
  import ConversationList from './conversation-list';
  import ConversationDetail from './conversation-detail';
  import EmptyState from './empty-state';

  export default async function InboxPage(props: { searchParams: Promise<{ conversation?: string }> }) {
    const { conversation: convId } = await props.searchParams;
    const ctx = await getTenantContext();
    const sb = await getSupabaseServerClient();
    const items = await listConversations(sb, ctx.clinicId, { includeResolved: false });
    const detail = convId ? await getConversationWithMessages(sb, ctx.clinicId, convId) : null;
    return (
      <div className="grid grid-cols-1 md:grid-cols-[360px_1fr] h-[calc(100vh-56px)]">
        <div className={`${convId ? 'hidden md:block' : 'block'}`}>
          <ConversationList items={items} selectedId={convId ?? null} />
        </div>
        <div className={`${convId ? 'block' : 'hidden md:block'}`}>
          {detail ? <ConversationDetail conversation={detail} clinicSlug={ctx.clinicSlug} /> : <EmptyState />}
        </div>
      </div>
    );
  }
  ```
- [ ] `empty-state.tsx`: centered flex, "Selecione uma conversa pra ver o histórico" (13px, `--luma-text-secondary`) + dica (12px, tertiary).
- [ ] Commit: `feat(web): inbox page server-component shell with mobile toggle`

### Task 11: Conversation list client component

**Files:** `conversation-list.tsx`, `conversation-avatar.tsx`, `relative-time.tsx`

- [ ] Add `date-fns: ^4` em `apps/web/package.json` + `pnpm install`.
- [ ] `relative-time.tsx`: `'use client'`, render `<time>{formatDistanceToNow(date, { addSuffix: true, locale: ptBR })}</time>`.
- [ ] `conversation-avatar.tsx`: hash de `seed` (phone) → 1 de 4 paletas (orange-pink, green-teal, blue-indigo, amber-orange via gradient `linear-gradient(135deg, ...)`). 36×36 rounded-full, iniciais (2 chars do nome ou últimos 2 dígitos do phone).
- [ ] `conversation-list.tsx`: `'use client'`, `<aside>` scroll, items com `<Link href="?conversation=<id>">`. Active state: `bg-[var(--luma-bg-subtle)]` quando `selectedId === c.id`. Layout: avatar + flex-1 (nome + relative-time topo / preview + unread badge baixo). Badge `unread_count > 0`: `bg-[var(--luma-accent)]` text-white rounded-full padding 2/8.
- [ ] Empty state inline: "Nenhuma conversa ainda" (centered, 13px, secondary).
- [ ] Commit: `feat(web): inbox conversation list with avatar + relative time`

### Task 12: Conversation detail panel

**Files:** `conversation-detail.tsx`, `send-message-form.tsx`

- [ ] `conversation-detail.tsx` (`'use client'`): header (nome paciente ou phone, badge de state, botão "← Voltar" mobile via `<Link href={`/${slug}/inbox`}>` `md:hidden`); thread scrollable com `useEffect` scroll-to-bottom on mount/messages change; bubbles inbound (left, `bg-[var(--luma-bg-subtle)]` rounded-12 padding 10×14 max-w-[75%]) e outbound (right, `bg-[var(--luma-accent-soft)]` mesmo formato); rodapé com `<SendMessageForm conversationId={c.id} />`.
- [ ] `send-message-form.tsx`: `<textarea>` 3 linhas, expand on focus, Enter envia (Shift+Enter quebra linha), botão "Enviar" disabled vazio/pending. Calls `sendMessageAction({conversationId, content})` → `toast.success` / `toast.error` via sonner. Limpa textarea no success.
- [ ] Commit: `feat(web): inbox detail panel with bubble thread + send form`

### Task 13: sendMessageAction (TDD)

**Files:** `actions.ts` + `actions.test.ts`

- [ ] **RED:** Tests usando `nock` mockando `https://api.kapso.ai`:
  - 200 success → INSERTs outbound message com `external_id` da response
  - 503/network error → retorna `{error}`, NÃO insere row
  - content > 4096 chars → zod rejeita
  - conversationId inválido → `{error: 'Conversa não encontrada.'}`
  - integration `status !== 'active'` → `{error: 'Integração WhatsApp inativa.'}`
  - `phone_number_id` ausente em `config` → `{error: 'phone_number_id ainda não capturado…'}`
- [ ] **GREEN:**
  ```typescript
  'use server';
  import { z } from 'zod';
  import { revalidatePath } from 'next/cache';
  import { getTenantContext, getSupabaseServerClient, getSupabaseAdminClient } from '@medina/auth';
  import { addMessage } from '@medina/chat';

  const SendSchema = z.object({ conversationId: z.string().uuid(), content: z.string().min(1).max(4096) });

  export async function sendMessageAction(input: { conversationId: string; content: string }) {
    const parsed = SendSchema.safeParse(input);
    if (!parsed.success) return { error: 'Mensagem inválida.' };
    const ctx = await getTenantContext();
    const sb = await getSupabaseServerClient();
    const { data: conv } = await sb.from('conversations')
      .select('id, clinic_id, integration_id, external_id')
      .eq('id', parsed.data.conversationId).is('deleted_at', null).maybeSingle();
    if (!conv) return { error: 'Conversa não encontrada.' };
    const admin = getSupabaseAdminClient();
    const { data: integ } = await admin.from('clinic_integrations').select('*')
      .eq('id', conv.integration_id).is('deleted_at', null).single();
    if (!integ || integ.status !== 'active') return { error: 'Integração WhatsApp inativa.' };
    const cfg = (integ.config ?? {}) as Record<string, unknown>;
    const phoneNumberId = cfg['phone_number_id'] as string | undefined;
    if (!phoneNumberId) return { error: 'phone_number_id ainda não capturado — receba 1 mensagem inbound primeiro.' };
    const { data: credJson } = await admin.rpc('get_integration_credential', { p_integration_id: integ.id });
    if (!credJson) return { error: 'Credenciais Kapso não disponíveis.' };
    const creds = JSON.parse(credJson as string) as { api_key: string };
    const res = await fetch(`https://api.kapso.ai/meta/whatsapp/v24.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'X-API-Key': creds.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: conv.external_id, type: 'text', text: { body: parsed.data.content } }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { error: `Kapso retornou ${res.status}: ${txt.slice(0, 200)}` };
    }
    const json = await res.json() as { messages?: Array<{ id: string }> };
    const externalId = json.messages?.[0]?.id ?? null;
    await addMessage(admin, {
      clinicId: ctx.clinicId, conversationId: conv.id, direction: 'outbound',
      senderType: 'human', senderUserId: ctx.user.id, contentType: 'text',
      content: parsed.data.content, externalId, deliveryStatus: 'sent',
    });
    revalidatePath(`/${ctx.clinicSlug}/inbox`);
    return { ok: true as const };
  }
  ```
- [ ] Commit: `feat(web): sendMessageAction with Kapso API integration`

### Task 14: Verification end-to-end

- [ ] `pnpm --filter @medina/db test` → 96 verde
- [ ] `pnpm --filter @medina/chat test` → todos verde
- [ ] `pnpm --filter @medina/integrations-whatsapp-kapso test` → todos verde
- [ ] `pnpm --filter @medina/web test` (se houver) → todos verde
- [ ] `pnpm typecheck` raiz → zero erros
- [ ] `pnpm build` → sucesso
- [ ] `pnpm dev` → manual:
  1. `/<slug>/inbox` carrega vazio.
  2. WhatsApp pro número Kapso → conversa aparece após F5.
  3. Click conversa → thread renderiza com mensagem do paciente.
  4. Digita resposta → Enviar → toast success, mensagem aparece no thread como balão direito.
  5. Webhook `delivered` chega → `delivery_status='delivered'` no DB (verificar SQL Editor).
  6. Mobile (`< md`): list visível; click → detail full-width com botão Voltar.
- [ ] Screenshots (lista vazia / 1 conversa / thread / mobile) → anexar PR.

### Task 15: PR

- [ ] `git status` clean no worktree.
- [ ] `git push -u origin g/chat-1-webhook-and-inbox`
- [ ] `gh pr create --base main --title "feat(chat): CHAT-1 webhook receiver kapso + inbox UI"` com body que liste:
  - O que entrega (resumo das tasks)
  - O que NÃO entrega (CHAT-2/3/4 explícito)
  - Test plan (checkmarks dos testes locais)
  - Como testar manualmente (URL ngrok, enviar WhatsApp, etc.)
  - Screenshots
  - Limitações conhecidas (race condition status webhook antes do INSERT outbound, `phone_number_id` lazy capture)
- [ ] Aguarda CodeRabbit + review humano. **NÃO mergeia.**

---

## Schema-migration-checklist self-check

Migration nova: **NENHUMA**. Schema 0005/0006 cobre tudo. RLS já tem `(select auth.uid())` (commit `f08235b`). Trigger `update_conversation_on_message` já existe e idempotente.

- [x] Policy auth.uid() — N/A (sem migration)
- [x] FK cross-tenant trigger — N/A
- [x] BEFORE/AFTER trigger — N/A
- [x] SECURITY DEFINER + search_path — N/A
- [x] supabase-js sem SET parametrizado — vault path elimina GUC
- [x] Audit log user_id NULL — webhook insere via admin → `auth.uid()` NULL → suportado em audit_logs

## Riscos

- **HMR adapter re-register:** `registry.register()` é Map.set overwrite, idempotente. Safe.
- **HMAC sig over JSON.stringify vs rawBody:** se Kapso assina `JSON.stringify(payload)` byte-diferente do body recebido, sig quebra. Verifier atual usa rawBody. Fallback se necessário em produção: re-assinar com `JSON.stringify(JSON.parse(rawBody))`.
- **Status webhook race:** `delivered` pode chegar antes do INSERT outbound completar. addMessage usa `delivery_status: 'sent'` default; webhook update por (clinic_id, external_id) retorna `message_not_found` se row ainda não existe. Status final fica `'sent'`. Aceitável.
- **`integration.config` UPDATE concorrente:** múltiplos webhooks → "last write wins" no `phone_number_id`. Determinístico (mesmo valor sempre), idempotente.

## Out-of-scope follow-ups

- Realtime push (CHAT-2)
- Outbox + Inngest retry (CHAT-2)
- Bot/IA reply pipeline (CHAT-3)
- Anexos download/upload (CHAT-4)
- Templates HSM
- Filtros UI (estado, atendente, busca, tag)
- Read receipts (mark inbound como lido ao abrir)
- Bulk actions

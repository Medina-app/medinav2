# AI-6 — Memory persistente de fatos administrativos (LGPD-safe)

## Context

Hoje o agente Medina é amnésico entre conversas: cada turno carrega só os últimos 20 messages da conversa atual (`dispatcher.ts:111-206`). Quando o paciente retorna semanas depois, o agente perde nome preferido, profissão, plano de saúde declarado — UX ruim e re-pergunta administrativa repetitiva.

AI-6 introduz memória persistente **escopada a fatos não-médicos**, configurável por clínica (default OFF). Dados sensíveis em saúde (sintomas, diagnósticos, medicações) **nunca** entram nessa memória — ficam confinados ao thread original e RLS habitual. O extractor Haiku tem prompt e schema que **rejeitam** qualquer fato categorizado como médico.

**Decisões já tomadas** (responder antes de planejar):
- Config armazenada em `clinics.metadata->'ai_memory'` (sem migration extra pra config).
- v1 cobre categorias **`administrative`** + **`financial`** (sem scheduling prefs).
- Retenção: **6 meses sem reuso** (touch-based — `last_referenced_at` atualiza quando fact é lido no contexto).
- Extração roda **no fim da conversa** (transição `closed`/`escalated`), não a cada turno.

## Worktree e branch

- Worktree: `.worktrees/ai-6-memory` derivado de `main@3d518ae`
- Branch: `g/ai-6-memory`
- Plan canônico copiado pra `plans/ai-6-memory-administrative-facts.md` no worktree (esse arquivo aqui é o working draft)

## Schema (Migration 0031)

**Arquivo**: `packages/db/migrations/0031_patient_facts.sql`

Seguir patterns de `0030_appointments_calcom_uid_unique.sql` (header decorativo + ordering DDL→RLS→indexes→triggers→functions→grants).

### Tabela `public.patient_facts`

```sql
- id              uuid PK default gen_random_uuid()
- clinic_id       uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE
- patient_id      uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE
- category        text NOT NULL CHECK (category IN ('administrative','financial'))
- key             text NOT NULL                    -- slug: 'preferred_name', 'profession', 'health_plan'
- value           text NOT NULL                    -- extracted scalar value
- confidence      numeric(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1)
- source_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL
- source_message_id      uuid REFERENCES messages(id)      ON DELETE SET NULL
- last_referenced_at     timestamptz NOT NULL DEFAULT now()
- created_at             timestamptz NOT NULL DEFAULT now()
- updated_at             timestamptz NOT NULL DEFAULT now()
- deleted_at             timestamptz
- forget_reason          text                              -- 'user_request' | 'expired' | 'admin_delete'
- UNIQUE (clinic_id, patient_id, category, key) WHERE deleted_at IS NULL
```

### Indexes
- `(clinic_id, patient_id) WHERE deleted_at IS NULL` — leitura no inbox sidebar + dispatcher
- `(clinic_id, last_referenced_at) WHERE deleted_at IS NULL` — varredura do cron de expiry

### RLS
- Enable RLS
- `SELECT`: `is_clinic_member(clinic_id)` (helper de `0000_core_schema.sql:74-86`)
- `INSERT/UPDATE/DELETE`: bloqueado pra `authenticated`. Workers usam service_role; UI vai via SECURITY DEFINER functions.

### Trigger
- `BEFORE UPDATE` → `set_updated_at()` (função global existente em `0000_core_schema.sql:7-13`)

### Funções SECURITY DEFINER

**`forget_patient_facts(p_patient_id uuid, p_category text DEFAULT NULL, p_reason text DEFAULT 'user_request')`**
- Resolve `v_clinic_id` via `patients` lookup
- Guard: `has_clinic_role(v_clinic_id,'admin') OR has_clinic_role(v_clinic_id,'owner')` → senão `RAISE EXCEPTION 'access denied'`
- Soft-delete: `UPDATE patient_facts SET deleted_at=now(), forget_reason=p_reason WHERE patient_id=$1 AND (p_category IS NULL OR category=p_category) AND deleted_at IS NULL`
- Retorna `int` (qtd de rows afetadas)
- `search_path = public, pg_catalog, pg_temp`
- REVOKE FROM PUBLIC; GRANT EXECUTE TO authenticated, service_role

**`expire_old_patient_facts()`**
- Roda como service_role (chamado pelo cron Inngest)
- `UPDATE patient_facts SET deleted_at=now(), forget_reason='expired' WHERE deleted_at IS NULL AND last_referenced_at < now() - interval '6 months'`
- Retorna `int`
- REVOKE FROM PUBLIC; GRANT EXECUTE TO service_role

**`touch_patient_fact(p_fact_id uuid)`**
- Service_role only. `UPDATE ... SET last_referenced_at=now() WHERE id=$1 AND deleted_at IS NULL`
- Chamada pelo dispatcher quando injeta o fact no contexto

### Config opcional em `clinics.metadata`
Sem migration de schema — apenas convenção:
```json
{ "ai_memory": { "enabled": false, "categories": ["administrative"], "enabled_at": "...", "enabled_by": "uuid" } }
```

## Camada AI (`packages/ai/src/memory/`)

Estrutura nova (paralela a `packages/ai/src/guardrails/`):

| Arquivo | Responsabilidade |
|---|---|
| `memory/types.ts` | Zod schemas: `FactCategory`, `ExtractedFact`, `ExtractionInput`, `ExtractionOutput`. Whitelist de keys por categoria. |
| `memory/extractor.ts` | `extractFacts(input): Promise<ExtractedFact[]>` — chama Haiku via OpenRouter mimicando `guardrails/haiku-classifier.ts:54-120` (JSON-mode forçado via system prompt, sem tool-use). |
| `memory/store.ts` | `loadPatientFacts(supabase, clinicId, patientId)`, `upsertFacts(supabase, clinicId, patientId, facts, sourceIds)`, `forgetFacts(supabase, clinicId, patientId, category?)`, `touchFactsById(supabase, factIds)`. |
| `memory/context.ts` | `buildPatientFactsContext(facts): string` — formata pra injeção no system prompt (markdown listinha). |

**Extractor prompt** (em pt-BR, conciso):
- Sistema: "Você extrai APENAS fatos administrativos/financeiros não-médicos. NUNCA inclua sintomas, diagnósticos, medicações ou queixas de saúde. Responda só com JSON válido `{facts: [...]}`."
- Whitelist de keys: `preferred_name | full_name | age | profession | address_neighborhood | health_plan_name | preferred_payment_method` (rejeita anything else)
- Schema Zod valida output antes de retornar; facts que falham validação são dropadas silenciosamente.

## Dispatcher hook (`packages/ai/src/dispatcher.ts`)

### Antes da chamada Anthropic (após linha ~206, post-tools-built)
1. Se `metadata.ai_memory.enabled === true` na clinic:
   - `const facts = await loadPatientFacts(supabase, clinicId, patient.id)`
   - Filtrar por categorias habilitadas em `metadata.ai_memory.categories`
   - `const memorySection = buildPatientFactsContext(facts)`
   - Append `memorySection` ao system prompt (ou injetar como mensagem `<patient_memory>` antes do histórico)
   - Fire-and-forget: `touchFactsById(supabase, facts.map(f=>f.id))` (não bloqueia o turno)

### Após dispatch
Quando a conversa transiciona pra `closed` ou `escalated` (ver lógica de state em `packages/chat`):
- Emit Inngest event `ai/patient-facts.extract-requested` com `{clinicId, conversationId, patientId}`
- Fire-and-forget; não bloqueia resposta ao usuário

## Inngest functions (`apps/web/lib/inngest/functions/`)

Seguir pattern de `dispatch-ai-agent.ts` (handler testável puro + wrapper `createFunction` + deps injetados via `makeDefaultDeps()`).

### `extract-patient-facts.ts`
- Trigger: `ai/patient-facts.extract-requested`
- Retries: 2
- Handler:
  1. Carrega clinic config; se memory desligado → no-op (`return {skipped: 'memory_disabled'}`)
  2. Carrega últimas N (=50) mensagens da conversa via service_role supabase
  3. Chama `extractFacts(...)` com as mensagens + categorias habilitadas
  4. `upsertFacts(...)` (ON CONFLICT (clinic_id, patient_id, category, key) DO UPDATE SET value, confidence, source_*, last_referenced_at=now() WHEN EXCLUDED.confidence >= patient_facts.confidence)
  5. Retorna `{inserted, updated, skipped}` pra Inngest dashboard

### `expire-old-facts.ts`
- Trigger: cron `0 3 1 * *` (mensal, dia 1 às 03:00)
- Handler: chama RPC `expire_old_patient_facts()` via service_role; loga total expired.

Registrar ambos em `apps/web/app/api/inngest/route.ts`.

## UI Settings (`apps/web/app/[slug]/settings/`)

Nova seção `ai-memory/`:
- `page.tsx` (server component) — fetch tenant context + `clinics.metadata.ai_memory`; passa pra form. Owner/admin only (mesmo pattern de `knowledge/page.tsx`).
- `AiMemoryForm.tsx` (client) — `<Switch>` master enabled + 2 `<Checkbox>` opt-in (Administrativo, Financeiro). Médico não aparece nem como opção desabilitada (intencional).
- `actions.ts` — server action `saveAiMemoryConfig(input)`: Zod valida, `hasPermission(ctx.role, 'clinic:manage')`, update `clinics.metadata = jsonb_set(metadata, '{ai_memory}', ...)`. `revalidatePath`.

Adicionar link "IA / Memory" no nav de `settings/layout.tsx`.

## UI Inbox — painel lateral de facts

### Layout
`apps/web/app/[slug]/inbox/page.tsx`: mudar grid de `[360px_1fr]` pra `[360px_1fr_320px]` no `md+`. Mobile: o painel direito vira `<Sheet>` acionado por botão "Memória" no header da conversa.

### Componente novo
`apps/web/app/[slug]/inbox/_components/PatientFactsPanel.tsx` (server component):
- Renderiza Card com sections por categoria
- Cada fact mostra `key`, `value`, e (admin/owner only) botão "Esquecer" que dispara server action
- `<EmptyState>` quando memory desligado ou paciente sem facts (com link pra Settings)

### Loader
Estender `packages/chat/src/inbox.ts:getConversationWithMessages` pra também trazer `patient_facts` filtrados (`deleted_at IS NULL`, ordenados por categoria → key). Server component passa pro `PatientFactsPanel`.

### Server action de forget
`apps/web/app/[slug]/inbox/_actions/forget-fact.ts`:
- Input: `{ patientId, factId?, category? }`
- Guard role admin/owner
- Chama RPC `forget_patient_facts(p_patient_id, p_category, 'admin_delete')` (se fact único, varia pra delete direto via SECURITY DEFINER alternativo OU adiciona overload `forget_patient_fact_by_id`)
- `revalidatePath`

## Order de implementação (TDD obrigatório)

1. **Migration 0031** — escrever SQL, aplicar local via `supabase db reset` ou `apply_migration` MCP em branch de dev. Validar com `list_tables` + `list_extensions`.
2. **Tests-first** (todos failing antes de implementar):
   - `packages/ai/tests/memory/extraction.test.ts` — mock OpenRouter fetch, assert categories whitelist + reject de fact médico + Zod validation
   - `packages/ai/tests/memory/context-injection.test.ts` — feed facts no fake supabase, assert dispatcher concatena no system prompt + ignora se `ai_memory.enabled=false`
   - `packages/ai/tests/memory/forget.test.ts` — admin chama → ok; non-admin → throws; soft-delete preserva row com `forget_reason`
3. **Implementação ai/memory** — `types.ts` → `extractor.ts` → `store.ts` → `context.ts` (testes 1-3 ficam verdes)
4. **Dispatcher wiring** — `loadPatientFacts` antes + emit event após. Testes existentes de dispatcher devem continuar passando.
5. **Inngest extract-patient-facts** + test em `apps/web/lib/inngest/functions/__tests__/`
6. **Inngest expire-old-facts cron** + test
7. **Registrar functions** em `apps/web/app/api/inngest/route.ts`
8. **UI Settings** — page + form + actions; teste manual com toggle on/off
9. **UI Inbox** — extend `getConversationWithMessages`, `PatientFactsPanel`, forget action

## Critical files a tocar

- `packages/db/migrations/0031_patient_facts.sql` (novo)
- `packages/ai/src/memory/{types,extractor,store,context}.ts` (novo)
- `packages/ai/tests/memory/{extraction,context-injection,forget}.test.ts` (novo)
- `packages/ai/src/dispatcher.ts` (~linha 206 hook in + ~linha 459 hook out)
- `apps/web/lib/inngest/functions/extract-patient-facts.ts` (novo)
- `apps/web/lib/inngest/functions/expire-old-facts.ts` (novo)
- `apps/web/lib/inngest/functions/__tests__/{extract-patient-facts,expire-old-facts}.test.ts` (novo)
- `apps/web/app/api/inngest/route.ts` (registrar 2 funcs)
- `apps/web/app/[slug]/settings/ai-memory/{page,AiMemoryForm,actions}.tsx` + `.ts` (novo)
- `apps/web/app/[slug]/settings/layout.tsx` (add nav item)
- `apps/web/app/[slug]/inbox/page.tsx` (grid 3-col)
- `apps/web/app/[slug]/inbox/_components/PatientFactsPanel.tsx` (novo)
- `apps/web/app/[slug]/inbox/_actions/forget-fact.ts` (novo)
- `packages/chat/src/inbox.ts` (estende `getConversationWithMessages`)

## Funções/utilities a reusar (não recriar)

- `is_clinic_member()`, `has_clinic_role()` — `packages/db/migrations/0000_core_schema.sql:74-102`
- `set_updated_at()` — `packages/db/migrations/0000_core_schema.sql:7-13`
- Haiku via OpenRouter — pattern de `packages/ai/src/guardrails/haiku-classifier.ts:54-120`
- Inngest handler shape — `apps/web/lib/inngest/functions/dispatch-ai-agent.ts`
- Tenant context + role check — `getTenantContext()`, `hasPermission(role, 'clinic:manage')`
- shadcn `<Switch>`, `<Card>`, `<Sheet>`, `<Dialog>` — já adotados no projeto
- Luma tokens — `--luma-bg-card`, `--luma-border`, `--luma-text-secondary` (em `apps/web/app/globals.css:59-75`)

## Verification (end-to-end)

1. **Suite completa**
   - `pnpm -w test` → 407 atuais + ~25 novos (extraction, context-injection, forget, inngest x2)
   - `pnpm -w typecheck` em 10 packages (zero `any`, zero `@ts-ignore`)
   - `pnpm -w build` (Next 15 strict)
2. **Migration aplicada local**
   - `supabase db reset` num branch isolado OU MCP `apply_migration` em sandbox
   - `list_tables` confirma `patient_facts` + RLS enabled
   - `get_advisors` zero warnings novos
3. **Smoke manual no dev server**
   - Settings: liga memory + categoria Administrativo → reload → toggle persiste em `clinics.metadata`
   - Inbox: abre conversa, painel direito mostra empty state
   - Trigger fake `ai/patient-facts.extract-requested` via Inngest dev UI com payload de conversa de teste → assert fact aparece no Supabase + sidebar reload
   - Admin clica "Esquecer" → fact some do sidebar + `deleted_at` setado na DB
   - Toggle memory OFF → próximo dispatch não injeta facts no prompt (verificar via Langfuse trace)
4. **LGPD guard test**
   - Conversa com mensagens contendo sintoma ("dor no peito") + fato adm ("meu plano é Unimed")
   - Após extract: assert no DB existe `health_plan='Unimed'` e NÃO existe nenhum fact com categoria fora da whitelist
5. **Cron expiry**
   - Seed fact com `last_referenced_at = now() - interval '7 months'`
   - Invocar handler manualmente via Inngest dev → fact fica com `deleted_at` + `forget_reason='expired'`

## PR

- Título: `feat(ai): AI-6 memory persistente admin facts (LGPD-safe)`
- Body: link pro plano, screenshots de Settings + Inbox sidebar, output da suite (`407 + N pass`), nota explícita "**não mergear** — aguarda review do sócio".
- NÃO mergear. CodeRabbit + review humano antes.

## Riscos e mitigations

- **Risco**: Haiku extrai fato categorizado como adm que na verdade é PHI marginal (ex: "estou grávida"). **Mitigation**: whitelist rígido de keys + Zod reject + post-extract regex blocklist (palavras: "grávida", "diagnóstico", "sintoma", "medicação", "remédio", "alergia", "dor").
- **Risco**: Race entre extract após escalate e admin abrir conversa antes do extract terminar. **Mitigation**: sidebar mostra empty state + spinner com hint "memória sendo atualizada" se `last extract_event` < 30s atrás.
- **Risco**: Cron expire dispara em prod com milhões de rows → table lock. **Mitigation**: function usa `UPDATE ... WHERE id IN (SELECT id ... LIMIT 1000)` em loop com sleep, ou simplesmente o cron mensal aceita lock curto pq table cresce devagar (raros writes).
- **Risco**: Custo Haiku acumula. **Mitigation**: extract só no fim da conversa (não por turno) — escolhido. Tracking via Langfuse trace por extract event.

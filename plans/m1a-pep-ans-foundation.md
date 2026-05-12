# M1a — PEP ANS Doctor Foundation + Leitura (Mednobre) Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. TDD required where applicable; HTTP adapter + tools são `RED → fetch mock → GREEN`; migrations seguem schema-migration-checklist.

**Goal:** Habilita a primeira clínica cliente real (Mednobre) com integração read-only ao PEP ANS — paciente identificado por telefone, agente lista especialidades + dias + horários disponíveis. SEM confirmar agendamento (vem em M1b com SAGA pattern).

**Architecture:** 3 tabelas catalog (`pep_specialties`, `pep_doctors`, `pep_procedures`) populadas via seed script no provisioning da clínica + flag `metadata.scheduling_provider ∈ {pep_ans|calcom|none}` em `clinics`. HTTP client ANS reusa shape do `CalcomClient` (Bearer auth, retry exponential, timeout, typed errors). Dispatcher inspeciona `scheduling_provider` no toolCtx setup e injeta o client correto. 3 tools novas read-only consomem o client ANS + catalog tables. UI admin é catalog viewer + toggle provider em settings.

**Tech Stack:** Postgres 15 SQL puro · `@supabase/supabase-js` · TypeScript estrito · Vitest (vi.mock pra fetch) · Mastra agent tools · Next.js 15 server components + actions · Tailwind v4 Luma tokens.

---

## ⚠️ Open Questions Before Implementation

Duas concerns reais que precisam decisão antes de eu codar:

### 1. ANS Mednobre API contract — UNKNOWN

Credenciais fornecidas (`clinica_token`, `clinica_id`, `clinica_unidade_id`), MAS o contrato HTTP da API não está no codebase. Não sei:

- **Base URL** (e.g., `https://api.ans-mednobre.com.br/v1`?)
- **Auth scheme** (Bearer? `X-Clinica-Token` header? query param? form auth?)
- **Endpoint shapes** pra os 3 métodos:
  - `lookupPatientByPhone(phone)` — Path? POST com body `{telefone}` ou GET com query `?telefone=`? Response shape com `{nome, id_paciente, cpf, …}`?
  - `listAvailableDays(doctor_id, month)` — Range mensal? Semanal? Response `{dias: ['2026-06-15', …]}` ou `[{data, qtd_horarios}]`?
  - `listAvailableHours(doctor_id, date)` — Response `{horarios: ['09:00', '10:00', …]}` ou `[{inicio, fim, duracao}]`?
- **Rate limits** (pra dimensionar retry + cache)
- **Erros conhecidos** (e.g., 404 paciente não encontrado vs. 500 ANS down)

**Bloqueante:** sem contrato real, qualquer implementação é especulativa e quebrará no primeiro teste contra ANS de verdade. Preciso de uma das opções:

- **A** — Compartilha link da doc ANS (Postman, OpenAPI, PDF). Implemento contra o contrato real.
- **B** — Acesso a um endpoint sandbox/staging. Faço discovery via curl e implemento.
- **C** — Sample requests/responses (paste de curl ou Postman). Inferência a partir desses.
- **D** — Implemento com shape **assumido** baseado em padrões comuns brasileiros (tipo dr.consulta API), claramente marcado como `TODO: validar contra ANS real`, com fixtures pra os tests. Risco: divergência alta com produção; ajuste no M1b.

**Recomendação:** **A** ou **B**. Sem isso, o adapter ANS é blind speculation.

### 2. Escopo M1a excede convenção de 600 LOC por PR

Estimativa do diff:

| Área | LOC |
|---|---|
| Migration 0037 + tests RLS | ~250 |
| ANS HTTP client + errors + types + tests | ~400 |
| Adapter (3 métodos) + tests | ~250 |
| Seed catalog script + data fixtures | ~350 |
| 3 tools + tests | ~500 |
| Dispatcher routing + tests | ~150 |
| UI admin (catálogo + toggle) | ~400 |
| **Total estimado** | **~2300 LOC** |

CLAUDE.md regra: `PRs < 600 linhas de diff (exceto scaffolding inicial)`. M1a é ~4x esse limite.

**Recomendação:** split em 3 PRs:
- **M1a-1**: schema + ANS client + adapter (read-only) — fundação testável isolada (~900 LOC)
- **M1a-2**: seed catalog + 3 tools + dispatcher routing — wire-up agente (~800 LOC)
- **M1a-3**: UI admin (catalog viewer + toggle) — atendente vê configuração (~600 LOC)

Cada um mergeável independentemente. Se preferir um único M1a monolítico, posso seguir mas o review fica longo.

---

## File Structure (consolidated; will split per recomendação acima se ok)

### Migrations
- Create: `packages/db/migrations/0037_pep_catalog_and_scheduling_provider.sql` — 3 tabelas catalog + scheduling_provider em metadata clinics

### Integrations (ANS adapter)
- Create: `packages/integrations/pep/ans/package.json` — novo workspace package
- Create: `packages/integrations/pep/ans/tsconfig.json` — extends root, strict
- Create: `packages/integrations/pep/ans/src/client.ts` — `AnsClient` HTTP client (Bearer/header auth, retry, typed errors)
- Create: `packages/integrations/pep/ans/src/adapter.ts` — `lookupPatientByPhone`, `listAvailableDays`, `listAvailableHours`
- Create: `packages/integrations/pep/ans/src/errors.ts` — `AnsApiError`, `AnsPatientNotFoundError`, `AnsUnavailableError`
- Create: `packages/integrations/pep/ans/src/types.ts` — request/response types
- Create: `packages/integrations/pep/ans/tests/client.test.ts` — fetch mock, retry, timeout, error mapping
- Create: `packages/integrations/pep/ans/tests/adapter.test.ts` — 3 methods happy + error paths

### Seed
- Create: `packages/db/scripts/seed-pep-catalog.ts` — script CLI que recebe clinic_id e popula 3 tabelas
- Create: `packages/db/scripts/seed-pep-catalog.data.ts` — dataset Mednobre (20 specialties + 25 doctors + procedures)
- Create: `packages/db/tests/rls/pep-catalog.test.ts` — schema + RLS tests

### AI Tools
- Create: `packages/ai/src/tools/check-pep-patient.ts` — lookup por telefone via ANS client
- Create: `packages/ai/src/tools/check-pep-availability.ts` — listAvailableDays + listAvailableHours
- Create: `packages/ai/src/tools/list-pep-specialties.ts` — query catalog table local
- Create: `packages/ai/tests/tools/check-pep-patient.test.ts`
- Create: `packages/ai/tests/tools/check-pep-availability.test.ts`
- Create: `packages/ai/tests/tools/list-pep-specialties.test.ts`

### Dispatcher routing
- Modify: `packages/ai/src/types.ts` — `ToolContext.ansClient?`, `ToolContext.schedulingProvider`
- Modify: `packages/ai/src/dispatcher.ts:240-280` — read `clinics.metadata.scheduling_provider`; build `ansClient` quando `pep_ans`
- Create: `packages/ai/src/ans-config.ts` — mirror de `calcom-config.ts` (resolveAnsConfig)
- Modify: `packages/ai/src/tools/build.ts` — registrar 3 tools novas
- Modify: `packages/ai/tests/dispatcher.test.ts` — testes pra routing toggle pep_ans vs calcom
- Modify: `apps/web/lib/inngest/functions/dispatch-ai-agent.ts` — wireia `buildAnsClient` em produção

### UI Admin
- Modify: `apps/web/app/[slug]/settings/integrations/page.tsx` — substitui placeholder
- Create: `apps/web/app/[slug]/settings/integrations/scheduling-provider-toggle.tsx` — UI client component pro toggle
- Create: `apps/web/app/[slug]/settings/integrations/actions.ts` — server action `updateSchedulingProvider`
- Create: `apps/web/app/[slug]/settings/pep-catalog/page.tsx` — catalog viewer read-only
- Create: `apps/web/app/[slug]/settings/pep-catalog/_components/SpecialtiesTable.tsx`
- Create: `apps/web/app/[slug]/settings/pep-catalog/_components/DoctorsTable.tsx`
- Create: `apps/web/app/[slug]/settings/pep-catalog/_components/ProceduresTable.tsx`
- Create: `apps/web/tests/actions/scheduling-provider-action.test.ts`

---

## Task 1 — Migration 0037: catalog tables + scheduling_provider

**Files:**
- Create: `packages/db/migrations/0037_pep_catalog_and_scheduling_provider.sql`
- Create: `packages/db/tests/rls/pep-catalog.test.ts`

### Schema design

```sql
-- 0037_pep_catalog_and_scheduling_provider.sql
--
-- M1a: PEP ANS Doctor Foundation. Tres catalogs read-only populados via seed
-- por clinica (Mednobre é o primeiro consumidor). Flag scheduling_provider
-- em clinics.metadata indica qual integração de scheduling esta ativa.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── pep_specialties ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pep_specialties (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  ans_id       text        NOT NULL,                         -- id externo no ANS
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  active       boolean     NOT NULL DEFAULT true,
  metadata     jsonb       NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  updated_at   timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, ans_id)
);

-- ─── pep_doctors ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pep_doctors (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  specialty_id  uuid        NOT NULL REFERENCES public.pep_specialties(id) ON DELETE CASCADE,
  ans_id        text        NOT NULL,
  full_name     text        NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
  crm           text,
  crm_state     text,
  active        boolean     NOT NULL DEFAULT true,
  metadata      jsonb       NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, ans_id)
);

-- ─── pep_procedures ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pep_procedures (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  specialty_id    uuid        REFERENCES public.pep_specialties(id) ON DELETE SET NULL,
  ans_id          text        NOT NULL,
  name            text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  is_nobrecard    boolean     NOT NULL DEFAULT false,        -- M1a flag pra Mednobre
  active          boolean     NOT NULL DEFAULT true,
  metadata        jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, ans_id)
);

-- ─── Cross-tenant trigger pra FKs FK (specialty_id, doctor.specialty) ─────────
-- pep_doctors.specialty_id deve apontar pra specialty da MESMA clinic.
-- pep_procedures.specialty_id idem (quando não NULL).
CREATE OR REPLACE FUNCTION public.validate_pep_specialty_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_specialty_clinic uuid;
BEGIN
  IF NEW.specialty_id IS NULL THEN RETURN NEW; END IF;
  SELECT clinic_id INTO v_specialty_clinic
  FROM public.pep_specialties WHERE id = NEW.specialty_id;
  IF v_specialty_clinic IS DISTINCT FROM NEW.clinic_id THEN
    RAISE EXCEPTION 'pep: cross-tenant violation specialty.clinic_id=% vs row.clinic_id=%',
      v_specialty_clinic, NEW.clinic_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pep_doctors_specialty_clinic
  BEFORE INSERT OR UPDATE OF specialty_id, clinic_id ON public.pep_doctors
  FOR EACH ROW EXECUTE FUNCTION public.validate_pep_specialty_clinic();

CREATE TRIGGER trg_pep_procedures_specialty_clinic
  BEFORE INSERT OR UPDATE OF specialty_id, clinic_id ON public.pep_procedures
  FOR EACH ROW EXECUTE FUNCTION public.validate_pep_specialty_clinic();

REVOKE EXECUTE ON FUNCTION public.validate_pep_specialty_clinic()
  FROM PUBLIC, anon, authenticated;

-- ─── RLS policies ─────────────────────────────────────────────────────────────
ALTER TABLE public.pep_specialties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pep_specialties FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pep_doctors     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pep_doctors     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pep_procedures  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pep_procedures  FORCE ROW LEVEL SECURITY;

-- Members podem SELECT do próprio clinic. Insert/Update/Delete = service_role
-- only (catálogo só é mutado via seed/admin script).
CREATE POLICY "pep_specialties: members select" ON public.pep_specialties
  FOR SELECT USING (is_clinic_member(clinic_id));
CREATE POLICY "pep_doctors: members select" ON public.pep_doctors
  FOR SELECT USING (is_clinic_member(clinic_id));
CREATE POLICY "pep_procedures: members select" ON public.pep_procedures
  FOR SELECT USING (is_clinic_member(clinic_id));

GRANT SELECT ON public.pep_specialties, public.pep_doctors, public.pep_procedures TO authenticated;

-- ─── set_updated_at triggers ──────────────────────────────────────────────────
CREATE TRIGGER trg_pep_specialties_updated_at
  BEFORE UPDATE ON public.pep_specialties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_pep_doctors_updated_at
  BEFORE UPDATE ON public.pep_doctors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_pep_procedures_updated_at
  BEFORE UPDATE ON public.pep_procedures
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Indexes pra lookups frequentes do agente ─────────────────────────────────
CREATE INDEX idx_pep_specialties_clinic_active ON public.pep_specialties (clinic_id) WHERE active;
CREATE INDEX idx_pep_doctors_clinic_specialty_active ON public.pep_doctors (clinic_id, specialty_id) WHERE active;
CREATE INDEX idx_pep_procedures_clinic_specialty ON public.pep_procedures (clinic_id, specialty_id) WHERE active;
```

**Nota sobre `clinics.metadata.scheduling_provider`:** não é coluna nova; é chave dentro do JSONB existente. Sem migration de schema — leitura via `clinic.metadata->>'scheduling_provider'`. Defaults aplicados no app side (`?? 'none'`). Se preferir coluna dedicada (ex: `clinics.scheduling_provider TEXT NOT NULL DEFAULT 'none'`), me avisa — adiciono no 0037.

### Tests (DB integration)

```typescript
describe('pep_specialties RLS + cross-tenant (M1a)', () => {
  it('member can SELECT specialties of own clinic only', async () => { /* ... */ });
  it('UNIQUE(clinic_id, ans_id) blocks duplicate seed re-runs', async () => { /* ... */ });
});

describe('pep_doctors specialty cross-tenant trigger (M1a)', () => {
  it('rejects doctor with specialty_id from different clinic', async () => {
    // setup specialty in clinic A, try to insert doctor with that specialty_id but clinic B
    // expect RAISE 'cross-tenant violation specialty.clinic_id'
  });
  it('accepts doctor with specialty_id from same clinic', async () => { /* ... */ });
});

describe('pep_procedures.is_nobrecard flag (M1a Mednobre)', () => {
  it('defaults false; accepts true; queryable for filter', async () => { /* ... */ });
});
```

### Apply migration

`mcp__plugin_supabase_supabase__apply_migration` com query do arquivo. Run `get_advisors` security+performance — esperar zero novos warnings.

### Commit

```bash
git add packages/db/migrations/0037_pep_catalog_and_scheduling_provider.sql \
        packages/db/tests/rls/pep-catalog.test.ts
git commit -m "feat(db): M1a pep catalog tables (specialties/doctors/procedures) + cross-tenant triggers"
```

---

## Task 2 — ANS HTTP Client + Adapter

**🚨 Bloqueado por Open Question 1 acima.** Sem contrato real, conteúdo abaixo é a estrutura — payload shape preencho após você responder.

**Files:**
- Create: `packages/integrations/pep/ans/{package.json, tsconfig.json}` — workspace package
- Create: `packages/integrations/pep/ans/src/{client.ts, adapter.ts, errors.ts, types.ts}`
- Create: `packages/integrations/pep/ans/tests/{client.test.ts, adapter.test.ts}`

### Client skeleton (mirror CalcomClient)

```typescript
// packages/integrations/pep/ans/src/client.ts
interface AnsClientOpts {
  baseUrl: string;
  clinicaToken: string;
  clinicaId: number;
  clinicaUnidadeId: number;
  // retry/timeout opts iguais CalcomClient
}

export class AnsClient {
  // private fields + constructor
  async lookupPatientByPhone(phone: string): Promise<AnsPatient | null> { /* TODO: contract */ }
  async listAvailableDays(args: { doctorId: string; from: string; to: string }): Promise<string[]> { /* TODO */ }
  async listAvailableHours(args: { doctorId: string; date: string }): Promise<AnsTimeSlot[]> { /* TODO */ }
  // private: requestWithRetry, fetchWithTimeout, throwTypedError, sleep
}
```

### Adapter delegations

```typescript
// packages/integrations/pep/ans/src/adapter.ts
export interface AnsAdapter {
  lookupPatientByPhone: AnsClient['lookupPatientByPhone'];
  listAvailableDays:    AnsClient['listAvailableDays'];
  listAvailableHours:   AnsClient['listAvailableHours'];
}
export function makeAnsAdapter(client: AnsClient): AnsAdapter { /* delegate */ }
```

### Tests (TDD per method)

Para cada método: `fetch` mock retorna fixture happy → adapter parse → asserções. Plus error paths: 404, 429 com retry, 500 sem retry, timeout, malformed JSON.

### Commit (após contract clarification)

```bash
git commit -m "feat(integrations): M1a ANS PEP HTTP client + adapter (lookup + availability)"
```

---

## Task 3 — Seed PEP Catalog

**Files:**
- Create: `packages/db/scripts/seed-pep-catalog.ts` — CLI: `pnpm tsx packages/db/scripts/seed-pep-catalog.ts <clinic-slug>`
- Create: `packages/db/scripts/seed-pep-catalog.data.ts` — Mednobre dataset

### Dataset structure

```typescript
export interface SeedSpecialty { ansId: string; name: string; }
export interface SeedDoctor { ansId: string; fullName: string; specialtyAnsId: string; crm?: string; crmState?: string; }
export interface SeedProcedure { ansId: string; name: string; specialtyAnsId?: string; isNobrecard: boolean; }

export const MEDNOBRE_SEED = {
  specialties: [ /* 20 entries */ ],
  doctors:     [ /* 25 entries */ ],
  procedures:  [ /* N entries with is_nobrecard flag */ ],
};
```

**Open:** dataset completo (20+25+N) precisa de você ou source — não tenho o catálogo Mednobre real. Posso usar:
- Placeholder com nomes genéricos (`Cardiologia`, `Dr. João Silva`, etc.) marcados pra substituir
- Você compartilha o CSV/JSON da Mednobre e eu adapto

### Idempotency

INSERT ON CONFLICT (clinic_id, ans_id) DO UPDATE — re-run do seed atualiza nomes mas preserva IDs. Trigger validate_pep_specialty_clinic dispara nos doctors/procedures e protege cross-tenant.

### Tests

```typescript
describe('seedPepCatalog (M1a)', () => {
  it('idempotent: second run updates names without breaking FKs', async () => { /* ... */ });
  it('rejects when clinic.metadata.scheduling_provider != pep_ans', async () => { /* opcional guard */ });
});
```

### Commit

```bash
git commit -m "feat(db): M1a seed-pep-catalog script + Mednobre dataset (specialties/doctors/procedures)"
```

---

## Task 4 — 3 AI Tools

### 4a. `check_pep_patient` (lookup by phone via ANS)

```typescript
// packages/ai/src/tools/check-pep-patient.ts
const InputSchema = z.object({
  phone: z.string().regex(/^\+?\d{10,15}$/).describe('E.164 ou nacional 10-15 dígitos'),
});

export function buildCheckPepPatientTool(ctx: ToolContext) {
  return createTool({
    id: 'check_pep_patient',
    description: 'Verifica se um telefone tem cadastro PEP. Retorna nome + id_paciente quando achado, ou flag pra cadastro.',
    inputSchema: InputSchema,
    execute: async ({ phone }) => {
      const { ansClient } = ctx;
      if (!ansClient) return { ok: false, error: 'pep_not_configured', message: '...' };
      const patient = await ansClient.lookupPatientByPhone(phone);
      return patient
        ? { ok: true, exists: true, patientId: patient.id, fullName: patient.fullName }
        : { ok: true, exists: false, message: 'Paciente não cadastrado no PEP — agente sugere cadastro humano.' };
    },
  });
}
```

### 4b. `check_pep_availability` (days + hours combo)

Tool consome `listAvailableDays` para um doctorId num range, depois `listAvailableHours` pra cada dia escolhido (max 3 dias). Retorna estrutura comprimida `{ doctorId, byDate: { '2026-06-15': ['09:00', '10:00'], … } }` truncada pra cota LLM.

### 4c. `list_pep_specialties` (catalog query local)

Pura query local em `pep_specialties WHERE clinic_id = ctx.clinicId AND active`. Sem ANS roundtrip — o catalog tá no DB. Retorna `{ specialties: [{ id, name }] }`.

### Tests (vi.mock ansClient + supabase chain)

Mirror estrutura de `check-availability.test.ts` — happy path, ansClient ausente (return ok:false), erro do client propaga.

### Tool registry

Modify `packages/ai/src/tools/build.ts` pra incluir os 3 IDs. Modify `packages/db/scripts/seed-agent-config.ts` (se existir) pra defaults incluir tools PEP quando clinic.scheduling_provider==='pep_ans'.

### Commit (3 sub-commits ou 1)

```bash
git commit -m "feat(ai): M1a check_pep_patient tool (lookup by phone via ANS adapter)"
git commit -m "feat(ai): M1a check_pep_availability tool (days+hours via ANS adapter)"
git commit -m "feat(ai): M1a list_pep_specialties tool (catalog query)"
```

---

## Task 5 — Dispatcher Routing (scheduling_provider toggle)

**Files:**
- Create: `packages/ai/src/ans-config.ts` (mirror `calcom-config.ts`)
- Modify: `packages/ai/src/types.ts` — adiciona `ansClient?`, `schedulingProvider: 'pep_ans'|'calcom'|'none'`
- Modify: `packages/ai/src/dispatcher.ts` — antes do `toolCtx`:
  ```typescript
  const schedulingProvider =
    (clinicRow as { metadata?: { scheduling_provider?: string } })?.metadata?.scheduling_provider ?? 'none';
  const needsAns = schedulingProvider === 'pep_ans' && buildAnsClient !== undefined &&
    toolNames.some(n => n === 'check_pep_patient' || n === 'check_pep_availability');
  const ansConfig  = needsAns ? await resolveAnsConfig(supabase, clinicId) : null;
  const ansClient  = ansConfig && buildAnsClient ? buildAnsClient(ansConfig) : undefined;
  ```
  No `toolCtx`: `ansClient`, `schedulingProvider`.

  **Importante:** dispatcher AGORA lê `clinics.metadata` (já lê pra default_agent_name fallback adicionada em PR-E). Estender SELECT pra `metadata` no clinicRow lookup.

- Modify: `apps/web/lib/inngest/functions/dispatch-ai-agent.ts` — wireia `buildAnsClient` real em produção (sibling do `buildCalcomClient`).

### Tests

```typescript
describe('dispatcher M1a scheduling routing', () => {
  it('clinic.metadata.scheduling_provider=pep_ans + PEP tools => ansClient injected', async () => { /* ... */ });
  it('clinic.metadata.scheduling_provider=calcom + calcom tools => calcomClient injected (no regress)', async () => { /* ... */ });
  it('clinic.metadata.scheduling_provider=none => neither client injected; PEP tools return ok:false', async () => { /* ... */ });
});
```

### Commit

```bash
git commit -m "feat(ai): M1a dispatcher reads scheduling_provider; routes PEP vs Cal.com"
```

---

## Task 6 — UI Admin (catalog viewer + scheduling toggle)

### 6a. Toggle scheduling_provider em settings/integrations

Replace placeholder `apps/web/app/[slug]/settings/integrations/page.tsx`. Server component carrega `clinic.metadata.scheduling_provider` e renderiza:
- Card "Scheduling Provider" com radio: `pep_ans | calcom | none`
- Server action `updateSchedulingProvider({ provider })` atualiza `clinics.metadata` via supabase server client
- Permission gate: `hasPermission(ctx.role, 'integration:manage')` (existe per PR-A patterns)
- Audit via existing trigger em clinics

### 6b. Catalog viewer (read-only)

Rota nova `apps/web/app/[slug]/settings/pep-catalog/page.tsx`. Server component faz 3 SELECTs paralelos (`pep_specialties`, `pep_doctors`, `pep_procedures`) com pagination simples (limit 100 por tab). Tabs UI: Especialidades | Doctors | Procedures. Read-only (escrita só via seed script). Empty state quando `scheduling_provider !== 'pep_ans'`.

### Tests (action)

```typescript
describe('updateSchedulingProviderAction', () => {
  it('rejects non-admin via hasPermission', async () => { /* ... */ });
  it('writes to clinics.metadata.scheduling_provider, preserves other metadata keys', async () => { /* ... */ });
  it('Zod rejects invalid provider string', async () => { /* ... */ });
});
```

UI manual smoke test via `pnpm dev` (CLAUDE.md: "For UI or frontend changes, start the dev server and use the feature in a browser").

### Commit

```bash
git commit -m "feat(web): M1a settings/integrations scheduling toggle + pep-catalog viewer"
```

---

## Task 7 — Validation + PR

```bash
pnpm test
pnpm typecheck
pnpm build
```

Advisors check via MCP. Push branch + open PR sem mergear.

---

## Schema-migration-checklist self-review (Etapa 4)

- [x] Toda policy com auth.uid() usa (select auth.uid())? — N/A, policies aqui usam `is_clinic_member()` (helper já existente que internamente usa wrap)
- [x] FKs cross-tenant têm trigger de validação? — Sim, `validate_pep_specialty_clinic` em INSERT/UPDATE de specialty_id em pep_doctors + pep_procedures
- [x] Triggers BEFORE vs AFTER documentados? — BEFORE (precisa abortar antes do INSERT em caso de cross-tenant)
- [x] Funções SECURITY DEFINER têm search_path explícito? — Sim, `pg_catalog, public, pg_temp` (pg_catalog primeiro, lição do PR-D CodeRabbit)
- [x] Funções chamadas via supabase-js/postgres-js evitam SET parametrizado? — N/A (trigger function não é chamada via supabase-js)
- [x] Ordem de criação na migration sem forward references? — Specialties → trigger function → doctors+triggers → procedures+triggers
- [x] Audit log preparado pra user_id NULL? — N/A (PEP catalog não emite audit_log diretamente; mutações são service_role-only via seed)
- [x] Plan tem SQL REAL ou apenas placeholders? — SQL completo pra migration 0037
- [x] Nomes de colunas em testes batem com schema? — Verificado contra schemas em outras migrations (clinic_id, ans_id pattern consistente com `calcom_user_id`/`calcom_event_type_ids` em doctors)

---

## Resumo do que paro pra decidir antes de codar

1. **ANS API contract** (Open Question 1): A, B, C ou D?
2. **Escopo PR**: monolítico M1a (~2300 LOC) ou split em M1a-1/2/3? Recomendação forte: split.
3. **scheduling_provider**: JSONB key em `clinics.metadata` (proposto) ou coluna dedicada?
4. **Seed dataset**: você manda a fonte real Mednobre (CSV/JSON) ou implemento com placeholders + flag pra substituir?

Aguardando essas 4 respostas pra prosseguir com Task 1.

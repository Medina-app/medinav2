# Pipeline Schema (Issue 10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar tabelas `pipelines`, `pipeline_stages` e `deals` com RLS multi-tenant, triggers de validação cross-tenant em 4 níveis, audit log automático em mudança de stage, e schemas Drizzle.

**Architecture:** Três tabelas denormalizadas (todas com `clinic_id`) para performance de RLS. Triggers SECURITY DEFINER validam integridade FK cross-tenant em INSERT/UPDATE. `audit_deal_stage_change` é BEFORE (não AFTER) pois precisa modificar `NEW.won_at`, `NEW.lost_at` e `NEW.last_activity_at` além de gravar audit_log. Policy UPDATE de deals usa `(select auth.uid())` para evitar `auth_rls_initplan`.

**Tech Stack:** PostgreSQL · Drizzle ORM · Vitest · postgres.js · Supabase MCP

---

## Riscos sistemáticos (schema-migration-checklist Etapa 2)

| Risco | Mitigação |
|-------|-----------|
| `auth.uid()` direto em policies → `auth_rls_initplan` warn | Usar `(select auth.uid())` em USING e WITH CHECK da policy UPDATE de deals |
| Cross-tenant: stage.clinic_id ≠ pipeline.clinic_id | `validate_stage_clinic_match` BEFORE INSERT OR UPDATE OF clinic_id, pipeline_id |
| Cross-tenant: deal.clinic_id ≠ stage.clinic_id | `validate_deal_clinic_match` BEFORE INSERT OR UPDATE OF clinic_id, stage_id |
| Cross-tenant: deal.patient_id de outra clínica | `validate_deal_patient_clinic` BEFORE INSERT OR UPDATE OF patient_id, clinic_id |
| Cross-tenant: deal.conversation_id de outra clínica | `validate_deal_conversation_clinic` BEFORE INSERT OR UPDATE OF conversation_id, clinic_id |
| audit_deal_stage_change precisa modificar NEW | Trigger é BEFORE (não AFTER) — modificar NEW.won_at/lost_at/last_activity_at + gravar audit |
| Triggers SECURITY DEFINER sem search_path | `SET search_path = public, pg_catalog` em todas as funções |
| audit_logs.user_id NULL quando service_role | auth.uid() retorna NULL via service_role — coluna já aceita NULL (FK ON DELETE SET NULL) |
| Forward references na migration | Criar tabelas antes de triggers; funções antes de triggers que as chamam |

---

## Arquivos

| Ação | Path |
|------|------|
| Create | `packages/db/migrations/0007_pipeline.sql` |
| Create | `packages/db/src/schema/pipelines.ts` |
| Create | `packages/db/src/schema/pipeline-stages.ts` |
| Create | `packages/db/src/schema/deals.ts` |
| Modify | `packages/db/src/schema/index.ts` |
| Create | `packages/db/tests/rls/pipeline.test.ts` |
| Modify | `packages/db/tests/rls/helpers/setup.ts` |

---

## Task 1: Estender helpers de teste

**Files:** Modify `packages/db/tests/rls/helpers/setup.ts`

- [ ] Adicionar `createTestPipeline`, `createTestPipelineStage`, `createTestDeal` após `createTestMessage`:

```typescript
export async function createTestPipeline(
  sql: postgres.Sql,
  clinicId: string,
  opts: { name?: string; isDefault?: boolean } = {},
): Promise<{ id: string; clinic_id: string }> {
  const name = opts.name ?? `Pipeline ${Date.now()}`;
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO pipelines (clinic_id, name, is_default)
    VALUES (${clinicId}, ${name}, ${opts.isDefault ?? false})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestPipeline: no row returned');
  return row;
}

export async function createTestPipelineStage(
  sql: postgres.Sql,
  clinicId: string,
  pipelineId: string,
  opts: { name?: string; position?: number; stageType?: string } = {},
): Promise<{ id: string; clinic_id: string }> {
  const name = opts.name ?? `Stage ${Date.now()}`;
  const position = opts.position ?? 0;
  const stageType = opts.stageType ?? 'open';
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO pipeline_stages (clinic_id, pipeline_id, name, position, stage_type)
    VALUES (${clinicId}, ${pipelineId}, ${name}, ${position}, ${stageType})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestPipelineStage: no row returned');
  return row;
}

export async function createTestDeal(
  sql: postgres.Sql,
  clinicId: string,
  pipelineId: string,
  stageId: string,
  opts: { title?: string; position?: number } = {},
): Promise<{ id: string; clinic_id: string }> {
  const title = opts.title ?? `Deal ${Date.now()}`;
  const position = opts.position ?? 0;
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO deals (clinic_id, pipeline_id, stage_id, title, position)
    VALUES (${clinicId}, ${pipelineId}, ${stageId}, ${title}, ${position})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestDeal: no row returned');
  return row;
}
```

- [ ] Prepend ao `cleanupAll` (antes de `messages`):

```typescript
await sql`DELETE FROM deals`.catch(() => null);
await sql`DELETE FROM pipeline_stages`.catch(() => null);
await sql`DELETE FROM pipelines`.catch(() => null);
```

---

## Task 2: Escrever testes (RED)

**Files:** Create `packages/db/tests/rls/pipeline.test.ts`

Casos de teste obrigatórios:

1. **cross-tenant isolation** — uA só vê pipelines/stages/deals de cA (não de cB)
2. **member can create deal** — INSERT via RLS como 'member' retorna id
3. **assigned member can update own deal** — deal com `assigned_user_id = member.id` → UPDATE allowed
4. **non-assigned member cannot update** — deal assigned a outro → UPDATE retorna 0 rows
5. **admin can update any deal** — independente de assigned_user_id
6. **stage FK guard** — `pipeline_stages.clinic_id ≠ pipeline.clinic_id` → RAISE EXCEPTION
7. **deal patient FK guard** — `patient` de outra clínica → RAISE EXCEPTION
8. **deal conversation FK guard** — `conversation` de outra clínica → RAISE EXCEPTION
9. **deal stage FK guard** — `stage` de outra clínica → RAISE EXCEPTION
10. **move deal updates stage_id + position** — UPDATE confirma novos valores
11. **move to won stage sets won_at** — stage_type='won' → `won_at IS NOT NULL`, `lost_at IS NULL`
12. **move to lost stage sets lost_at** — stage_type='lost' → `lost_at IS NOT NULL`, `won_at IS NULL`
13. **audit log on stage change** — audit_logs: `action='deal.stage_changed'`, `resource='deals'`, `metadata.before.stage_id`, `metadata.after.stage_id`
14. **cascade delete** — DELETE pipeline → stages e deals são removidos em cascata
15. **unique default per clinic** — dois `is_default=true` na mesma clínica → UNIQUE violation
16. **two clinics can each have default** — `is_default=true` em clínicas diferentes → OK

- [ ] Rodar testes: `pnpm --filter @medina/db test` — esperar FAIL "relation does not exist"

---

## Task 3: Escrever migration

**Files:** Create `packages/db/migrations/0007_pipeline.sql`

```sql
-- ─── Table: pipelines ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pipelines (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description  text,
  color        text        NOT NULL DEFAULT '#06B6D4'
               CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  position     int         NOT NULL DEFAULT 0,
  is_default   boolean     NOT NULL DEFAULT false,
  archived_at  timestamptz,
  metadata     jsonb       NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  updated_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipelines_clinic_position
  ON public.pipelines (clinic_id, position)
  WHERE archived_at IS NULL;

-- Apenas 1 default por clínica (não arquivada)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_clinic_default_unique
  ON public.pipelines (clinic_id)
  WHERE is_default = true AND archived_at IS NULL;

-- ─── Table: pipeline_stages ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pipeline_stages (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  pipeline_id       uuid        NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  name              text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description       text,
  position          int         NOT NULL DEFAULT 0,
  color             text,
  stage_type        text        NOT NULL DEFAULT 'open'
                    CHECK (stage_type IN ('open', 'won', 'lost')),
  automation_rules  jsonb       NOT NULL DEFAULT '{}',
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_clinic_pipeline_position
  ON public.pipeline_stages (clinic_id, pipeline_id, position)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_clinic_pipeline_type
  ON public.pipeline_stages (clinic_id, pipeline_id, stage_type);

-- ─── Table: deals ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.deals (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id            uuid          NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  pipeline_id          uuid          NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  stage_id             uuid          NOT NULL REFERENCES public.pipeline_stages(id) ON DELETE RESTRICT,
  patient_id           uuid          REFERENCES public.patients(id) ON DELETE SET NULL,
  conversation_id      uuid          REFERENCES public.conversations(id) ON DELETE SET NULL,
  title                text          NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description          text,
  value                numeric(12,2),
  expected_close_date  date,
  position             int           NOT NULL DEFAULT 0,
  assigned_user_id     uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  priority             text          NOT NULL DEFAULT 'normal'
                       CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  tags                 text[]        NOT NULL DEFAULT '{}',
  source               text          CHECK (source IN ('whatsapp', 'manual', 'imported', 'website')),
  last_activity_at     timestamptz,
  won_at               timestamptz,
  lost_at              timestamptz,
  lost_reason          text,
  metadata             jsonb         NOT NULL DEFAULT '{}',
  created_by           uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  archived_at          timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT NOW(),
  updated_at           timestamptz   NOT NULL DEFAULT NOW()
);

-- Query principal do kanban: deals ativos por pipeline/stage ordenados por position
CREATE INDEX IF NOT EXISTS idx_deals_clinic_pipeline_stage_position
  ON public.deals (clinic_id, pipeline_id, stage_id, position)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deals_clinic_assigned
  ON public.deals (clinic_id, assigned_user_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deals_clinic_patient
  ON public.deals (clinic_id, patient_id)
  WHERE archived_at IS NULL AND patient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deals_clinic_conversation
  ON public.deals (clinic_id, conversation_id)
  WHERE archived_at IS NULL AND conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deals_tags
  ON public.deals USING GIN (tags);

-- ─── Triggers: set_updated_at ─────────────────────────────────────────────────

CREATE TRIGGER trg_pipelines_updated_at
  BEFORE UPDATE ON public.pipelines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_pipeline_stages_updated_at
  BEFORE UPDATE ON public.pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_deals_updated_at
  BEFORE UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Trigger: validate stage.clinic_id == pipeline.clinic_id ─────────────────
-- SECURITY DEFINER para bypassar RLS de pipelines no lookup.

CREATE OR REPLACE FUNCTION public.validate_stage_clinic_match()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_pipeline_clinic_id uuid;
BEGIN
  SELECT clinic_id INTO v_pipeline_clinic_id
  FROM   public.pipelines
  WHERE  id = NEW.pipeline_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pipeline not found';
  END IF;

  IF v_pipeline_clinic_id <> NEW.clinic_id THEN
    RAISE EXCEPTION 'pipeline_stage clinic_id does not match pipeline clinic_id';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pipeline_stages_validate_clinic
  BEFORE INSERT OR UPDATE OF clinic_id, pipeline_id ON public.pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION public.validate_stage_clinic_match();

-- ─── Trigger: validate deal.clinic_id == stage.clinic_id ─────────────────────

CREATE OR REPLACE FUNCTION public.validate_deal_clinic_match()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_stage_clinic_id uuid;
BEGIN
  SELECT clinic_id INTO v_stage_clinic_id
  FROM   public.pipeline_stages
  WHERE  id = NEW.stage_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pipeline_stage not found';
  END IF;

  IF v_stage_clinic_id <> NEW.clinic_id THEN
    RAISE EXCEPTION 'deal clinic_id does not match stage clinic_id';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deals_validate_stage_clinic
  BEFORE INSERT OR UPDATE OF clinic_id, stage_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.validate_deal_clinic_match();

-- ─── Trigger: validate deal.patient_id.clinic_id == deal.clinic_id ───────────

CREATE OR REPLACE FUNCTION public.validate_deal_patient_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.patient_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.patients
      WHERE id = NEW.patient_id AND clinic_id = NEW.clinic_id
    ) THEN
      RAISE EXCEPTION 'deal patient_id does not belong to the same clinic';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deals_validate_patient_clinic
  BEFORE INSERT OR UPDATE OF patient_id, clinic_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.validate_deal_patient_clinic();

-- ─── Trigger: validate deal.conversation_id.clinic_id == deal.clinic_id ──────

CREATE OR REPLACE FUNCTION public.validate_deal_conversation_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.conversation_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.conversations
      WHERE id = NEW.conversation_id AND clinic_id = NEW.clinic_id
    ) THEN
      RAISE EXCEPTION 'deal conversation_id does not belong to the same clinic';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deals_validate_conversation_clinic
  BEFORE INSERT OR UPDATE OF conversation_id, clinic_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.validate_deal_conversation_clinic();

-- ─── Trigger: audit stage change + set won_at/lost_at ────────────────────────
-- BEFORE (não AFTER) porque precisa modificar NEW.won_at, NEW.lost_at,
-- NEW.last_activity_at além de gravar audit_log.
-- user_id é NULL quando disparado por service_role (auth.uid() retorna NULL).

CREATE OR REPLACE FUNCTION public.audit_deal_stage_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_stage_type text;
BEGIN
  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    NEW.clinic_id,
    (select auth.uid()),
    'deal.stage_changed',
    'deals',
    NEW.id,
    jsonb_build_object(
      'before', jsonb_build_object('stage_id', OLD.stage_id),
      'after',  jsonb_build_object('stage_id', NEW.stage_id)
    )
  );

  NEW.last_activity_at := NOW();

  SELECT stage_type INTO v_stage_type
  FROM   public.pipeline_stages
  WHERE  id = NEW.stage_id;

  IF v_stage_type = 'won' THEN
    NEW.won_at  := NOW();
    NEW.lost_at := NULL;
  ELSIF v_stage_type = 'lost' THEN
    NEW.lost_at := NOW();
    NEW.won_at  := NULL;
  ELSE
    NEW.won_at  := NULL;
    NEW.lost_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deals_audit_stage_change
  BEFORE UPDATE OF stage_id ON public.deals
  FOR EACH ROW
  WHEN (OLD.stage_id IS DISTINCT FROM NEW.stage_id)
  EXECUTE FUNCTION public.audit_deal_stage_change();

-- ─── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.pipelines       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipelines       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_stages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.deals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deals           FORCE ROW LEVEL SECURITY;

-- pipelines: members lêem, admins escrevem
CREATE POLICY "pipelines: members can select"
  ON public.pipelines FOR SELECT
  USING (is_clinic_member(clinic_id));

CREATE POLICY "pipelines: admins can insert"
  ON public.pipelines FOR INSERT
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "pipelines: admins can update"
  ON public.pipelines FOR UPDATE
  USING  (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'))
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "pipelines: admins can delete"
  ON public.pipelines FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

-- pipeline_stages: members lêem, admins escrevem
CREATE POLICY "pipeline_stages: members can select"
  ON public.pipeline_stages FOR SELECT
  USING (is_clinic_member(clinic_id));

CREATE POLICY "pipeline_stages: admins can insert"
  ON public.pipeline_stages FOR INSERT
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "pipeline_stages: admins can update"
  ON public.pipeline_stages FOR UPDATE
  USING  (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'))
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "pipeline_stages: admins can delete"
  ON public.pipeline_stages FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

-- deals: members lêem tudo, members criam, assigned_user OU admin atualiza, admin deleta
-- (select auth.uid()) evita auth_rls_initplan warn
CREATE POLICY "deals: members can select"
  ON public.deals FOR SELECT
  USING (is_clinic_member(clinic_id));

CREATE POLICY "deals: members can insert"
  ON public.deals FOR INSERT
  WITH CHECK (is_clinic_member(clinic_id));

CREATE POLICY "deals: assigned or admin can update"
  ON public.deals FOR UPDATE
  USING  (assigned_user_id = (select auth.uid())
          OR has_clinic_role(clinic_id, 'admin')
          OR has_clinic_role(clinic_id, 'owner'))
  WITH CHECK (assigned_user_id = (select auth.uid())
          OR has_clinic_role(clinic_id, 'admin')
          OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "deals: admins can delete"
  ON public.deals FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

-- ─── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipelines       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipeline_stages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deals           TO authenticated;

REVOKE EXECUTE ON FUNCTION public.validate_stage_clinic_match()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_deal_clinic_match()         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_deal_patient_clinic()       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_deal_conversation_clinic()  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_deal_stage_change()            FROM PUBLIC, anon, authenticated;
```

- [ ] Rodar `pnpm --filter @medina/db test` — esperar FAIL (tabelas não existem)

---

## Task 4: Escrever Drizzle schemas

**Files:** Create `packages/db/src/schema/pipelines.ts`, `pipeline-stages.ts`, `deals.ts`

`pipelines.ts`:
```typescript
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clinics } from './clinics.js';

export const pipelines = pgTable('pipelines', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull().references(() => clinics.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color').notNull().default('#06B6D4'),
  position: integer('position').notNull().default(0),
  isDefault: boolean('is_default').notNull().default(false),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_pipelines_clinic_position').on(t.clinicId, t.position).where(sql`${t.archivedAt} IS NULL`),
  uniqueIndex('idx_pipelines_clinic_default_unique').on(t.clinicId).where(sql`${t.isDefault} = true AND ${t.archivedAt} IS NULL`),
  check('pipelines_name_length_check', sql`char_length(${t.name}) BETWEEN 1 AND 100`),
  check('pipelines_color_check', sql`${t.color} ~ '^#[0-9A-Fa-f]{6}$'`),
]);

export type Pipeline = typeof pipelines.$inferSelect;
export type NewPipeline = typeof pipelines.$inferInsert;
```

`pipeline-stages.ts`:
```typescript
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clinics } from './clinics.js';
import { pipelines } from './pipelines.js';

export type StageType = 'open' | 'won' | 'lost';

export const pipelineStages = pgTable('pipeline_stages', {
  id: uuid('id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull().references(() => clinics.id, { onDelete: 'cascade' }),
  pipelineId: uuid('pipeline_id').notNull().references(() => pipelines.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  position: integer('position').notNull().default(0),
  color: text('color'),
  stageType: text('stage_type').$type<StageType>().notNull().default('open'),
  automationRules: jsonb('automation_rules').notNull().default({}),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_pipeline_stages_clinic_pipeline_position').on(t.clinicId, t.pipelineId, t.position).where(sql`${t.archivedAt} IS NULL`),
  index('idx_pipeline_stages_clinic_pipeline_type').on(t.clinicId, t.pipelineId, t.stageType),
  check('pipeline_stages_name_length_check', sql`char_length(${t.name}) BETWEEN 1 AND 100`),
  check('pipeline_stages_type_check', sql`${t.stageType} IN ('open','won','lost')`),
]);

export type PipelineStage = typeof pipelineStages.$inferSelect;
export type NewPipelineStage = typeof pipelineStages.$inferInsert;
```

`deals.ts` — importa `clinics`, `pipelines`, `pipelineStages`, `patients`, `conversations`. Campos: `id, clinicId, pipelineId, stageId, patientId, conversationId, title, description, value (numeric 12,2), expectedCloseDate, position, assignedUserId, priority, tags (text[]), source, lastActivityAt, wonAt, lostAt, lostReason, metadata, createdBy, archivedAt, createdAt, updatedAt`. Checks: `title 1-200`, `priority IN (low/normal/high/urgent)`, `source IN (whatsapp/manual/imported/website)`.

- [ ] Modificar `index.ts`: adicionar exports de `./pipelines.js`, `./pipeline-stages.js`, `./deals.js`

---

## Task 5: Aplicar migration via Supabase MCP

- [ ] Chamar `mcp__supabase-medina__apply_migration` com `name: '0007_pipeline'` e o SQL da Task 3
- [ ] Se errar: mostrar mensagem de erro completa e PARAR

---

## Task 6: Rodar testes — GREEN

- [ ] `pnpm --filter @medina/db test` — todos os 16 testes de pipeline + 37 anteriores = 53 total verdes
- [ ] Se algum falhar: ler erro, identificar trigger ou policy com problema, corrigir via migration e re-rodar

---

## Task 7: Validar advisors

- [ ] `mcp__supabase-medina__get_advisors` (security + performance)
- [ ] Zero novos WARNs críticos de segurança gerados por esta migration
- [ ] WARNs pre-existentes (function_search_path_mutable em set_updated_at etc.) são aceitáveis

---

## Task 8: Commit

```bash
git add packages/db/migrations/0007_pipeline.sql \
        packages/db/src/schema/pipelines.ts \
        packages/db/src/schema/pipeline-stages.ts \
        packages/db/src/schema/deals.ts \
        packages/db/src/schema/index.ts \
        packages/db/tests/rls/pipeline.test.ts \
        packages/db/tests/rls/helpers/setup.ts \
        plans/issue-10-pipeline-schema.md
git commit -m "feat: issue 10 - pipeline schema with kanban support and rls"
```

---

## Self-check Etapa 4 (verificado antes de marcar completo)

- [x] Toda policy com auth.uid() usa (select auth.uid())? → deals UPDATE policy
- [x] FKs cross-tenant têm trigger documentado? → 4 triggers (stage, deal/stage, deal/patient, deal/conversation)
- [x] Triggers BEFORE vs AFTER documentados com razão? → audit_deal_stage_change é BEFORE pra modificar NEW
- [x] Funções SECURITY DEFINER têm search_path? → `SET search_path = public, pg_catalog` em todas
- [x] Evitam SET parametrizado? → N/A (sem set_config nesta migration)
- [x] Ordem sem forward references? → tabelas antes de triggers
- [x] Audit log preparado pra user_id NULL? → auth.uid() retorna NULL via service_role, coluna aceita NULL
- [x] Plan tem SQL REAL? → ✓ migration completa acima
- [x] Nomes de colunas batem com schema existente? → confirmado de 0000/0004/0005

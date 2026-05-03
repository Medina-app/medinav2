# Issue 11 — Scheduling Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar schema de agendamentos — tabelas doctors, appointments, appointment_reminders — com state machine, 5 triggers cross-tenant, audit log automático e helper transition_appointment_status.

**Architecture:** Tabelas espelham o estado do Cal.com externamente; clinic_id é a raiz de isolamento em todas as tabelas. A função transition_appointment_status valida a máquina de estados e cancela lembretes; triggers BEFORE/AFTER garantem timestamps e audit log em todas as rotas de escrita.

**Tech Stack:** Postgres 15, Supabase RLS, Drizzle ORM, Vitest, postgres.js (testes)

---

## Ficheiros

| Ação   | Caminho                                            |
|--------|----------------------------------------------------|
| Create | `packages/db/migrations/0008_scheduling.sql`       |
| Create | `packages/db/src/schema/doctors.ts`                |
| Create | `packages/db/src/schema/appointments.ts`           |
| Create | `packages/db/src/schema/appointment-reminders.ts`  |
| Modify | `packages/db/src/schema/index.ts`                  |
| Create | `packages/db/tests/rls/scheduling.test.ts`         |
| Modify | `packages/db/tests/rls/helpers/setup.ts`           |

---

## Task 1: Escrever testes (TDD RED)

**Files:**
- Modify: `packages/db/tests/rls/helpers/setup.ts`
- Create: `packages/db/tests/rls/scheduling.test.ts`

- [ ] Adicionar `createTestDoctor`, `createTestAppointment` ao setup.ts e atualizar `cleanupAll`
- [ ] Escrever scheduling.test.ts com todos os 11 cenários especificados
- [ ] Rodar `pnpm --filter @medina/db test tests/rls/scheduling.test.ts` e confirmar RED (tabelas não existem)

---

## Task 2: Escrever migration 0008_scheduling.sql

**Files:**
- Create: `packages/db/migrations/0008_scheduling.sql`

SQL real das tabelas, índices, triggers, funções e RLS (ver Etapa 3 do SQL abaixo).

### Tabela doctors

```sql
CREATE TABLE IF NOT EXISTS public.doctors (
  id                            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id                     uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  user_id                       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  full_name                     text        NOT NULL
                                            CHECK (char_length(full_name) BETWEEN 1 AND 200),
  specialty                     text,
  crm                           text,
  crm_state                     text,
  email                         text,
  phone                         text,
  bio                           text,
  avatar_url                    text,
  color                         text        NOT NULL DEFAULT '#06B6D4'
                                            CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  calcom_user_id                text,
  calcom_event_type_ids         text[],
  consultation_duration_minutes int         NOT NULL DEFAULT 30,
  consultation_price            numeric(10,2),
  accepts_insurance             boolean     NOT NULL DEFAULT false,
  active                        boolean     NOT NULL DEFAULT true,
  archived_at                   timestamptz,
  metadata                      jsonb       NOT NULL DEFAULT '{}',
  created_at                    timestamptz NOT NULL DEFAULT NOW(),
  updated_at                    timestamptz NOT NULL DEFAULT NOW()
);
```

### Tabela appointments

```sql
CREATE TABLE IF NOT EXISTS public.appointments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  doctor_id           uuid        NOT NULL REFERENCES public.doctors(id) ON DELETE RESTRICT,
  patient_id          uuid        REFERENCES public.patients(id) ON DELETE SET NULL,
  conversation_id     uuid        REFERENCES public.conversations(id) ON DELETE SET NULL,
  deal_id             uuid        REFERENCES public.deals(id) ON DELETE SET NULL,
  status              text        NOT NULL DEFAULT 'scheduled'
                                  CHECK (status IN (
                                    'scheduled','confirmed','in_progress','completed',
                                    'no_show','cancelled_by_patient','cancelled_by_clinic','rescheduled'
                                  )),
  start_at            timestamptz NOT NULL,
  end_at              timestamptz NOT NULL,
  timezone            text        NOT NULL DEFAULT 'America/Sao_Paulo',
  type                text        NOT NULL DEFAULT 'consultation'
                                  CHECK (type IN ('consultation','follow_up','procedure','exam','other')),
  modality            text        NOT NULL DEFAULT 'in_person'
                                  CHECK (modality IN ('in_person','telemedicine')),
  meeting_url         text,
  location            text,
  notes               text,
  price               numeric(10,2),
  payment_status      text        NOT NULL DEFAULT 'pending'
                                  CHECK (payment_status IN ('pending','paid','partial','refunded','waived')),
  calcom_booking_id   text,
  calcom_uid          text,
  pep_external_id     text,
  pep_provider        text,
  pep_synced_at       timestamptz,
  pep_sync_status     text        CHECK (pep_sync_status IS NULL OR pep_sync_status IN ('pending','synced','failed')),
  pep_sync_error      text,
  rescheduled_to_id   uuid        REFERENCES public.appointments(id) ON DELETE SET NULL,
  cancelled_at        timestamptz,
  cancellation_reason text,
  confirmed_at        timestamptz,
  completed_at        timestamptz,
  created_by          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_via         text        NOT NULL DEFAULT 'manual'
                                  CHECK (created_via IN ('manual','whatsapp','website','calcom_external','pep_sync')),
  metadata            jsonb       NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT appointments_end_after_start CHECK (end_at > start_at)
);
```

### Tabela appointment_reminders

```sql
CREATE TABLE IF NOT EXISTS public.appointment_reminders (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id   uuid        NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  clinic_id        uuid        NOT NULL,
  channel          text        NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  template_name    text,
  scheduled_at     timestamptz NOT NULL,
  sent_at          timestamptz,
  delivered_at     timestamptz,
  response_at      timestamptz,
  response_content text,
  status           text        NOT NULL DEFAULT 'scheduled'
                               CHECK (status IN ('scheduled','sent','delivered','failed','cancelled')),
  error_message    text,
  inngest_event_id text,
  metadata         jsonb       NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT NOW()
);
```

### Funções e triggers (resumo)

| Função                                   | Tipo         | Tabela                | SECURITY DEFINER |
|------------------------------------------|--------------|-----------------------|-----------------|
| `set_updated_at()`                       | BEFORE UPD   | doctors, appointments | N               |
| `set_appointment_timestamps()`           | BEFORE INS/UPD OF status | appointments | N         |
| `validate_appointment_doctor_clinic()`   | BEFORE INS/UPD OF clinic_id,doctor_id | appointments | Y |
| `validate_appointment_patient_clinic()`  | BEFORE INS/UPD OF patient_id,clinic_id | appointments | Y |
| `validate_appointment_conversation_clinic()` | BEFORE INS/UPD OF conversation_id,clinic_id | appointments | Y |
| `validate_appointment_deal_clinic()`     | BEFORE INS/UPD OF deal_id,clinic_id | appointments | Y |
| `audit_appointment_status_change()`      | AFTER UPD OF status WHEN changed | appointments | Y |
| `validate_reminder_clinic_match()`       | BEFORE INS   | appointment_reminders | Y |
| `transition_appointment_status()`        | Helper fn    | —                     | Y |

### State machine (transition_appointment_status)

```
scheduled   → confirmed | cancelled_* | rescheduled | in_progress
confirmed   → in_progress | cancelled_* | rescheduled | no_show
in_progress → completed
completed / no_show / cancelled_* / rescheduled → terminal (empty array)
```

### RLS summary

| Tabela                | SELECT             | INSERT          | UPDATE          | DELETE          |
|-----------------------|--------------------|-----------------|-----------------|-----------------|
| doctors               | members, archived=NULL | admins/owners | admins/owners | admins/owners |
| appointments          | members            | members         | members         | admins/owners   |
| appointment_reminders | members            | service_role    | service_role    | service_role    |

---

## Task 3: Aplicar migration via Supabase MCP

- [ ] Chamar `mcp__supabase-medina__apply_migration` com o SQL de 0008_scheduling.sql

---

## Task 4: Drizzle schemas + update index.ts

- [ ] Criar doctors.ts, appointments.ts, appointment-reminders.ts
- [ ] Atualizar index.ts com os 3 novos exports

---

## Task 5: Rodar testes (TDD GREEN)

- [ ] `pnpm --filter @medina/db test tests/rls/scheduling.test.ts`
- [ ] Confirmar todos os testes passando

---

## Task 6: Validar advisors e self-check

- [ ] Chamar `mcp__supabase-medina__get_advisors` e verificar zero warns críticos novos
- [ ] Self-check 9 itens do schema-migration-checklist

---

## Task 7: Commit local

- [ ] `git add packages/db/migrations/0008_scheduling.sql packages/db/src/schema packages/db/tests`
- [ ] `git commit -m "feat: issue 11 - scheduling schema with appointments, doctors and reminders"`

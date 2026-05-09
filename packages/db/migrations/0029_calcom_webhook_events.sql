-- ════════════════════════════════════════════════════════════════════════════
-- 0029_calcom_webhook_events.sql
--
-- AI-4: tabela de auditoria dedicada pra webhook events do Cal.com self-host.
--
-- Por que tabela separada e não audit_logs:
--   - Volume distinto: webhook events vêm em rajadas (BOOKING_CONFIRMED + UI
--     polling múltiplo); audit_logs ficaria poluído.
--   - Schema dedicado permite indexar por trigger_event + processed_at para
--     dashboards futuros (e.g. "% events processados < 5s").
--   - Dedup por (clinic_id, trigger_event, calcom_uid) em UNIQUE INDEX
--     parcial — replay do webhook colapsa idempotente sem mudar audit_logs.
--
-- Worker `process-calcom-event` faz UPSERT com ON CONFLICT (..) DO UPDATE
-- SET processed_at, error_message — replay seguro, sem duplicados.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.calcom_webhook_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  trigger_event   text        NOT NULL
                              CHECK (trigger_event IN (
                                'BOOKING_CREATED',
                                'BOOKING_CONFIRMED',
                                'BOOKING_RESCHEDULED',
                                'BOOKING_CANCELLED'
                              )),
  calcom_uid      text,
  appointment_id  uuid        REFERENCES public.appointments(id) ON DELETE SET NULL,
  payload         jsonb       NOT NULL,
  processed_at    timestamptz,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE public.calcom_webhook_events ENABLE ROW LEVEL SECURITY;

-- Members can SELECT their clinic's events (read-only audit pra UI futura).
DROP POLICY IF EXISTS "calcom_webhook_events: members read" ON public.calcom_webhook_events;
CREATE POLICY "calcom_webhook_events: members read"
  ON public.calcom_webhook_events
  FOR SELECT
  TO authenticated
  USING (
    (SELECT auth.uid()) IS NOT NULL
    AND public.is_clinic_member(clinic_id)
  );

-- Authenticated users CANNOT INSERT/UPDATE/DELETE — worker via service_role
-- escreve diretamente (RLS bypass por convenção). Sem policy de write.

-- Index pra worker pollar eventos não-processados (raro, fallback se Inngest cair).
CREATE INDEX IF NOT EXISTS idx_calcom_webhook_events_clinic_unprocessed
  ON public.calcom_webhook_events (clinic_id, processed_at)
  WHERE processed_at IS NULL;

-- Dedup parcial (calcom_uid pode ser NULL em payloads malformados que
-- ainda assim queremos logar — mas dedup só faz sentido com uid presente).
CREATE UNIQUE INDEX IF NOT EXISTS idx_calcom_webhook_events_dedup
  ON public.calcom_webhook_events (clinic_id, trigger_event, calcom_uid)
  WHERE calcom_uid IS NOT NULL;

-- Index pra lookup por appointment (UI mostrar histórico de eventos do agendamento).
CREATE INDEX IF NOT EXISTS idx_calcom_webhook_events_appointment
  ON public.calcom_webhook_events (appointment_id)
  WHERE appointment_id IS NOT NULL;

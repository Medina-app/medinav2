-- ════════════════════════════════════════════════════════════════════════════
-- 0030_appointments_calcom_uid_unique.sql
--
-- AI-4 follow-up (CodeRabbit PR #29): habilita upsert idempotente em
-- appointments por (clinic_id, calcom_uid).
--
-- Por quê:
--   process-calcom-event worker faz INSERT em appointments quando recebe
--   BOOKING_CREATED. Sem UNIQUE INDEX em (clinic_id, calcom_uid), retries
--   ou races (e.g. tool confirm_appointment + webhook chegando quase
--   simultâneo) podem gerar duplicados ou throw em race.
--
--   Já existe UNIQUE INDEX em (clinic_id, calcom_booking_id) na 0008, mas
--   booking_id pode mudar em reschedule (Cal.com self-host gera novo id),
--   enquanto calcom_uid é o identificador estável durante o lifecycle.
--
-- Idempotência:
--   .upsert(..., { onConflict: 'clinic_id,calcom_uid' }) no worker resolve
--   race em camada DB sem precisar de coordenação extra.
--
-- Pré-validado: SELECT verificou zero duplicatas em prod antes de aplicar
-- (sa-east-1, 2026-05-09).
-- ════════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_clinic_calcom_uid_unique
  ON public.appointments (clinic_id, calcom_uid)
  WHERE calcom_uid IS NOT NULL;

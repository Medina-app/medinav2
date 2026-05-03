-- ─── Table: public.doctors ────────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS idx_doctors_clinic_active
  ON public.doctors (clinic_id, active)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_doctors_clinic_user
  ON public.doctors (clinic_id, user_id)
  WHERE user_id IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_doctors_clinic_calcom_user
  ON public.doctors (clinic_id, calcom_user_id)
  WHERE calcom_user_id IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_doctors_full_name_trgm
  ON public.doctors USING gin (full_name gin_trgm_ops)
  WHERE archived_at IS NULL;

-- ─── Table: public.appointments ───────────────────────────────────────────────

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
  pep_sync_status     text        CHECK (pep_sync_status IS NULL
                                         OR pep_sync_status IN ('pending','synced','failed')),
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

-- Active appointments by doctor (avoids cancelled)
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_doctor_start
  ON public.appointments (clinic_id, doctor_id, start_at)
  WHERE status NOT IN ('cancelled_by_patient','cancelled_by_clinic');

-- Patient appointment history
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_patient_start
  ON public.appointments (clinic_id, patient_id, start_at DESC)
  WHERE patient_id IS NOT NULL;

-- Status-based listing
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_status_start
  ON public.appointments (clinic_id, status, start_at);

-- Upcoming appointments
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_upcoming
  ON public.appointments (clinic_id, start_at);

-- Cal.com deduplication
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_clinic_calcom_booking
  ON public.appointments (clinic_id, calcom_booking_id)
  WHERE calcom_booking_id IS NOT NULL;

-- PEP sync worker queue
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_pep_sync
  ON public.appointments (clinic_id, pep_sync_status)
  WHERE pep_sync_status IN ('pending','failed');

-- ─── Table: public.appointment_reminders ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.appointment_reminders (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id   uuid        NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  clinic_id        uuid        NOT NULL,
  channel          text        NOT NULL
                               CHECK (channel IN ('whatsapp','sms','email')),
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

-- Inngest worker queue: find scheduled reminders to send
CREATE INDEX IF NOT EXISTS idx_reminders_clinic_scheduled
  ON public.appointment_reminders (clinic_id, scheduled_at)
  WHERE status = 'scheduled';

-- Per-appointment channel listing
CREATE INDEX IF NOT EXISTS idx_reminders_appointment_channel
  ON public.appointment_reminders (appointment_id, channel);

-- Failed reminders retry queue
CREATE INDEX IF NOT EXISTS idx_reminders_clinic_status_scheduled
  ON public.appointment_reminders (clinic_id, status, scheduled_at)
  WHERE status IN ('scheduled','failed');

-- ─── Trigger: set_updated_at on doctors and appointments ─────────────────────

CREATE TRIGGER trg_doctors_updated_at
  BEFORE UPDATE ON public.doctors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_appointments_updated_at
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Trigger: set confirmed_at / completed_at / cancelled_at (BEFORE) ─────────
-- Plain function (no SECURITY DEFINER): only modifies NEW, no external queries.

CREATE OR REPLACE FUNCTION public.set_appointment_timestamps()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.status = 'confirmed'
     AND NEW.confirmed_at IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status <> 'confirmed') THEN
    NEW.confirmed_at := NOW();
  END IF;

  IF NEW.status = 'completed'
     AND NEW.completed_at IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status <> 'completed') THEN
    NEW.completed_at := NOW();
  END IF;

  IF NEW.status IN ('cancelled_by_patient','cancelled_by_clinic')
     AND NEW.cancelled_at IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('cancelled_by_patient','cancelled_by_clinic')) THEN
    NEW.cancelled_at := NOW();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_appointments_set_timestamps
  BEFORE INSERT OR UPDATE OF status ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.set_appointment_timestamps();

-- ─── Trigger: validate doctor belongs to same clinic ─────────────────────────
-- SECURITY DEFINER to bypass doctor RLS when running as a restricted user.

CREATE OR REPLACE FUNCTION public.validate_appointment_doctor_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.doctors
    WHERE id = NEW.doctor_id AND clinic_id = NEW.clinic_id
  ) THEN
    RAISE EXCEPTION 'appointment doctor_id does not belong to the same clinic';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_appointments_validate_doctor_clinic
  BEFORE INSERT OR UPDATE OF clinic_id, doctor_id ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.validate_appointment_doctor_clinic();

-- ─── Trigger: validate patient belongs to same clinic ─────────────────────────

CREATE OR REPLACE FUNCTION public.validate_appointment_patient_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.patient_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.patients
      WHERE id = NEW.patient_id AND clinic_id = NEW.clinic_id
    ) THEN
      RAISE EXCEPTION 'appointment patient_id does not belong to the same clinic';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_appointments_validate_patient_clinic
  BEFORE INSERT OR UPDATE OF patient_id, clinic_id ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.validate_appointment_patient_clinic();

-- ─── Trigger: validate conversation belongs to same clinic ────────────────────

CREATE OR REPLACE FUNCTION public.validate_appointment_conversation_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.conversation_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.conversations
      WHERE id = NEW.conversation_id AND clinic_id = NEW.clinic_id
    ) THEN
      RAISE EXCEPTION 'appointment conversation_id does not belong to the same clinic';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_appointments_validate_conversation_clinic
  BEFORE INSERT OR UPDATE OF conversation_id, clinic_id ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.validate_appointment_conversation_clinic();

-- ─── Trigger: validate deal belongs to same clinic ────────────────────────────

CREATE OR REPLACE FUNCTION public.validate_appointment_deal_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.deal_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.deals
      WHERE id = NEW.deal_id AND clinic_id = NEW.clinic_id
    ) THEN
      RAISE EXCEPTION 'appointment deal_id does not belong to the same clinic';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_appointments_validate_deal_clinic
  BEFORE INSERT OR UPDATE OF deal_id, clinic_id ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.validate_appointment_deal_clinic();

-- ─── Trigger: audit appointment status change (AFTER UPDATE) ─────────────────
-- auth.uid() returns NULL when fired by service_role — audit_logs.user_id allows NULL.

CREATE OR REPLACE FUNCTION public.audit_appointment_status_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    NEW.clinic_id,
    (SELECT auth.uid()),
    'appointment.status_changed',
    'appointments',
    NEW.id,
    jsonb_build_object(
      'before', jsonb_build_object('status', OLD.status),
      'after',  jsonb_build_object('status', NEW.status)
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_appointments_audit_status_change
  AFTER UPDATE OF status ON public.appointments
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.audit_appointment_status_change();

-- ─── Trigger: validate reminder clinic matches appointment ────────────────────

CREATE OR REPLACE FUNCTION public.validate_reminder_clinic_match()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_appt_clinic_id uuid;
BEGIN
  SELECT clinic_id INTO v_appt_clinic_id
  FROM   public.appointments
  WHERE  id = NEW.appointment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'appointment not found for reminder: %', NEW.appointment_id;
  END IF;

  IF v_appt_clinic_id <> NEW.clinic_id THEN
    RAISE EXCEPTION 'reminder clinic_id does not match appointment clinic_id';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_appointment_reminders_validate_clinic
  BEFORE INSERT ON public.appointment_reminders
  FOR EACH ROW EXECUTE FUNCTION public.validate_reminder_clinic_match();

-- ─── Helper: transition_appointment_status ────────────────────────────────────
-- Validates state machine, sets reason on cancel, cascades reminder cancellation.
-- Audit log is written by trg_appointments_audit_status_change (AFTER trigger).
-- SECURITY DEFINER so it can UPDATE appointments regardless of caller RLS context.

CREATE OR REPLACE FUNCTION public.transition_appointment_status(
  p_appointment_id uuid,
  p_new_status     text,
  p_reason         text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_old_status text;
  v_allowed    text[];
BEGIN
  SELECT status
  INTO   v_old_status
  FROM   public.appointments
  WHERE  id = p_appointment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'appointment not found: %', p_appointment_id;
  END IF;

  v_allowed := CASE v_old_status
    WHEN 'scheduled'   THEN ARRAY['confirmed','cancelled_by_patient','cancelled_by_clinic','rescheduled','in_progress']
    WHEN 'confirmed'   THEN ARRAY['in_progress','cancelled_by_patient','cancelled_by_clinic','rescheduled','no_show']
    WHEN 'in_progress' THEN ARRAY['completed']
    ELSE               ARRAY[]::text[]
  END;

  IF NOT (p_new_status = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'Invalid appointment status transition from % to %', v_old_status, p_new_status;
  END IF;

  UPDATE public.appointments
  SET
    status              = p_new_status,
    cancellation_reason = CASE
      WHEN p_new_status IN ('cancelled_by_patient','cancelled_by_clinic') THEN p_reason
      ELSE cancellation_reason
    END
  WHERE id = p_appointment_id;
  -- trg_appointments_set_timestamps sets cancelled_at/confirmed_at/completed_at (BEFORE)
  -- trg_appointments_audit_status_change inserts audit log (AFTER)

  IF p_new_status IN ('cancelled_by_patient','cancelled_by_clinic') THEN
    UPDATE public.appointment_reminders
    SET status = 'cancelled'
    WHERE appointment_id = p_appointment_id
      AND status = 'scheduled';
  END IF;
END;
$$;

-- ─── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.doctors               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctors               FORCE ROW LEVEL SECURITY;
ALTER TABLE public.appointments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_reminders FORCE ROW LEVEL SECURITY;

-- doctors: members read active, admins/owners write
CREATE POLICY "doctors: members can select"
  ON public.doctors FOR SELECT
  USING (is_clinic_member(clinic_id) AND archived_at IS NULL);

CREATE POLICY "doctors: admins can insert"
  ON public.doctors FOR INSERT
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "doctors: admins can update"
  ON public.doctors FOR UPDATE
  USING  (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'))
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "doctors: admins can delete"
  ON public.doctors FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

-- appointments: members read/write, admins delete
CREATE POLICY "appointments: members can select"
  ON public.appointments FOR SELECT
  USING (is_clinic_member(clinic_id));

CREATE POLICY "appointments: members can insert"
  ON public.appointments FOR INSERT
  WITH CHECK (is_clinic_member(clinic_id));

CREATE POLICY "appointments: members can update"
  ON public.appointments FOR UPDATE
  USING  (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

CREATE POLICY "appointments: admins can delete"
  ON public.appointments FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

-- appointment_reminders: members read; write is service_role only (bypasses RLS)
CREATE POLICY "appointment_reminders: members can select"
  ON public.appointment_reminders FOR SELECT
  USING (is_clinic_member(clinic_id));

-- ─── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.doctors               TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.appointments          TO authenticated;
GRANT SELECT                         ON public.appointment_reminders TO authenticated;

GRANT EXECUTE ON FUNCTION public.transition_appointment_status(uuid, text, text)
  TO authenticated;
REVOKE EXECUTE ON FUNCTION public.transition_appointment_status(uuid, text, text)
  FROM PUBLIC, anon;

-- Trigger functions must not be callable directly via REST or PostgREST
REVOKE EXECUTE ON FUNCTION public.set_appointment_timestamps()                  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_appointment_doctor_clinic()           FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_appointment_patient_clinic()          FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_appointment_conversation_clinic()     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_appointment_deal_clinic()             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_appointment_status_change()              FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_reminder_clinic_match()               FROM PUBLIC, anon, authenticated;

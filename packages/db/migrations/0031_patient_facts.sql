-- ════════════════════════════════════════════════════════════════════════════
-- 0031_patient_facts.sql
-- AI-6: Memory persistente de fatos administrativos/financeiros sobre pacientes.
-- LGPD-safe: nenhuma coluna armazena dado médico; categorias são fechadas via
-- CHECK constraint, e o extractor Haiku (na camada AI) rejeita facts médicos.
-- Config "ligado/categorias" vive em clinics.metadata->'ai_memory' (sem schema
-- novo pra config).
--
-- Cross-tenant guard: trigger BEFORE INSERT/UPDATE valida que clinic_id bate
-- com patients.clinic_id e (quando presentes) com conversations.clinic_id e
-- messages.clinic_id. Pattern segue validate_conversation_patient_clinic em
-- 0005_chat.sql:173-191.
--
-- Soft-delete via forget_reason; expiry via cron mensal (touch-based, 6 meses
-- sem reuso). Service_role gerencia writes do worker; UI usa SECURITY DEFINER
-- function forget_patient_facts pra apagar.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Table: patient_facts ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.patient_facts (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id                UUID         NOT NULL REFERENCES public.clinics(id)       ON DELETE CASCADE,
  patient_id               UUID         NOT NULL REFERENCES public.patients(id)      ON DELETE CASCADE,
  category                 TEXT         NOT NULL CHECK (category IN ('administrative','financial')),
  key                      TEXT         NOT NULL CHECK (char_length(key) BETWEEN 1 AND 64),
  value                    TEXT         NOT NULL CHECK (char_length(value) BETWEEN 1 AND 500),
  confidence               NUMERIC(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source_conversation_id   UUID         REFERENCES public.conversations(id)          ON DELETE SET NULL,
  source_message_id        UUID         REFERENCES public.messages(id)               ON DELETE SET NULL,
  last_referenced_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at               TIMESTAMPTZ,
  forget_reason            TEXT         CHECK (forget_reason IS NULL OR forget_reason IN ('user_request','expired','admin_delete')),
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One active fact per (clinic, patient, category, key). Soft-deleted rows
-- don't block re-extraction of the same key later.
CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_facts_unique_active
  ON public.patient_facts (clinic_id, patient_id, category, key)
  WHERE deleted_at IS NULL;

-- Inbox sidebar + dispatcher load: list facts for a patient.
CREATE INDEX IF NOT EXISTS idx_patient_facts_clinic_patient_active
  ON public.patient_facts (clinic_id, patient_id)
  WHERE deleted_at IS NULL;

-- Expiry cron sweep: scan active facts ordered by last_referenced_at.
CREATE INDEX IF NOT EXISTS idx_patient_facts_clinic_last_referenced_active
  ON public.patient_facts (clinic_id, last_referenced_at)
  WHERE deleted_at IS NULL;

-- ─── updated_at trigger ──────────────────────────────────────────────────────

CREATE TRIGGER trg_patient_facts_updated_at
  BEFORE UPDATE ON public.patient_facts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Cross-tenant validation trigger ─────────────────────────────────────────
-- SECURITY DEFINER so it can lookup patients/conversations/messages even when
-- caller is RLS-restricted. search_path locked to public + pg_catalog.

CREATE OR REPLACE FUNCTION public.validate_patient_facts_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_patient_clinic uuid;
  v_conv_clinic    uuid;
  v_msg_clinic     uuid;
BEGIN
  -- patient_id is NOT NULL on the table; lookup must succeed.
  SELECT clinic_id INTO v_patient_clinic
  FROM   public.patients
  WHERE  id = NEW.patient_id;

  IF v_patient_clinic IS NULL THEN
    RAISE EXCEPTION 'patient_facts: patient_id % not found', NEW.patient_id;
  END IF;

  IF v_patient_clinic <> NEW.clinic_id THEN
    RAISE EXCEPTION 'patient_facts: cross-tenant violation patient.clinic_id=% vs fact.clinic_id=%',
      v_patient_clinic, NEW.clinic_id;
  END IF;

  -- source_conversation_id is nullable. If present, validate.
  IF NEW.source_conversation_id IS NOT NULL THEN
    SELECT clinic_id INTO v_conv_clinic
    FROM   public.conversations
    WHERE  id = NEW.source_conversation_id;

    IF v_conv_clinic IS NOT NULL AND v_conv_clinic <> NEW.clinic_id THEN
      RAISE EXCEPTION 'patient_facts: cross-tenant violation conversation.clinic_id=% vs fact.clinic_id=%',
        v_conv_clinic, NEW.clinic_id;
    END IF;
  END IF;

  -- source_message_id is nullable. messages has clinic_id denormalized.
  IF NEW.source_message_id IS NOT NULL THEN
    SELECT clinic_id INTO v_msg_clinic
    FROM   public.messages
    WHERE  id = NEW.source_message_id;

    IF v_msg_clinic IS NOT NULL AND v_msg_clinic <> NEW.clinic_id THEN
      RAISE EXCEPTION 'patient_facts: cross-tenant violation message.clinic_id=% vs fact.clinic_id=%',
        v_msg_clinic, NEW.clinic_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_patient_facts_clinic() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_patient_facts_validate_clinic
  BEFORE INSERT OR UPDATE OF clinic_id, patient_id, source_conversation_id, source_message_id
  ON public.patient_facts
  FOR EACH ROW EXECUTE FUNCTION public.validate_patient_facts_clinic();

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- SELECT permitido a qualquer membro da clínica.
-- INSERT/UPDATE/DELETE bloqueados para authenticated: writes só via
-- service_role (worker do Inngest) ou via SECURITY DEFINER function
-- forget_patient_facts. Isso impede que UI faça update sem trilha auditável.

ALTER TABLE public.patient_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_facts FORCE ROW LEVEL SECURITY;

CREATE POLICY "patient_facts: members can select active"
  ON public.patient_facts FOR SELECT
  USING (is_clinic_member(clinic_id) AND deleted_at IS NULL);

GRANT SELECT ON public.patient_facts TO authenticated;

-- ─── forget_patient_facts ────────────────────────────────────────────────────
-- Soft-delete: sets deleted_at + forget_reason. Admin/owner only.
-- Optional category filter: passes NULL to forget all categories for the patient.
-- Returns number of rows soft-deleted.

CREATE OR REPLACE FUNCTION public.forget_patient_facts(
  p_patient_id UUID,
  p_category   TEXT DEFAULT NULL,
  p_reason     TEXT DEFAULT 'user_request'
)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_clinic_id UUID;
  v_count     INT;
BEGIN
  -- Resolve clinic via patient lookup (bypasses patient RLS).
  SELECT clinic_id INTO v_clinic_id
  FROM   public.patients
  WHERE  id = p_patient_id;

  IF v_clinic_id IS NULL THEN
    RAISE EXCEPTION 'patient not found';
  END IF;

  IF NOT has_clinic_role(v_clinic_id, 'admin')
     AND NOT has_clinic_role(v_clinic_id, 'owner') THEN
    RAISE EXCEPTION 'access denied: requires admin or owner role';
  END IF;

  IF p_reason IS NULL OR p_reason NOT IN ('user_request','admin_delete') THEN
    RAISE EXCEPTION 'invalid forget reason: %', p_reason;
  END IF;

  IF p_category IS NOT NULL AND p_category NOT IN ('administrative','financial') THEN
    RAISE EXCEPTION 'invalid category: %', p_category;
  END IF;

  UPDATE public.patient_facts
  SET    deleted_at    = NOW(),
         forget_reason = p_reason
  WHERE  patient_id  = p_patient_id
    AND  clinic_id   = v_clinic_id
    AND  deleted_at IS NULL
    AND  (p_category IS NULL OR category = p_category);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Audit trail (user_id is NULL when invoked via service_role).
  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    auth.uid(),
    'patient_facts.forgotten',
    'patient_facts',
    p_patient_id,
    jsonb_build_object('category', p_category, 'reason', p_reason, 'count', v_count)
  );

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.forget_patient_facts(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.forget_patient_facts(UUID, TEXT, TEXT) TO authenticated, service_role;

-- ─── expire_old_patient_facts ────────────────────────────────────────────────
-- Cron-only: invoked by Inngest scheduled function via service_role.
-- Touch-based expiry: facts whose last_referenced_at < now() - 6 months get
-- soft-deleted with reason 'expired'. Batched limit prevents long locks on
-- prod tables with many rows. Inngest can re-run if count = 1000 (not fully drained).

CREATE OR REPLACE FUNCTION public.expire_old_patient_facts(p_batch_limit INT DEFAULT 1000)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_count INT;
BEGIN
  IF p_batch_limit IS NULL OR p_batch_limit < 1 OR p_batch_limit > 10000 THEN
    RAISE EXCEPTION 'invalid batch limit: %', p_batch_limit;
  END IF;

  WITH targets AS (
    SELECT id
    FROM   public.patient_facts
    WHERE  deleted_at IS NULL
      AND  last_referenced_at < NOW() - INTERVAL '6 months'
    ORDER  BY last_referenced_at ASC
    LIMIT  p_batch_limit
  )
  UPDATE public.patient_facts pf
  SET    deleted_at    = NOW(),
         forget_reason = 'expired'
  FROM   targets
  WHERE  pf.id = targets.id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.expire_old_patient_facts(INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.expire_old_patient_facts(INT) TO service_role;

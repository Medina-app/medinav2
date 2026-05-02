-- ─── CPF helpers ─────────────────────────────────────────────────────────────
-- encrypt_cpf / decrypt_cpf use pgcrypto pgp_sym_encrypt/decrypt.
-- Key comes from session config: SET app.encryption_key = '...';
-- These functions are SECURITY DEFINER but restricted from PUBLIC —
-- only service_role may call them directly.
-- Authenticated users must go through get_patient_cpf which enforces role checks.

CREATE OR REPLACE FUNCTION public.encrypt_cpf(cpf text, key text)
RETURNS bytea LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog AS $$
  SELECT pgp_sym_encrypt(cpf, key);
$$;

CREATE OR REPLACE FUNCTION public.decrypt_cpf(encrypted bytea, key text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog AS $$
  SELECT pgp_sym_decrypt(encrypted, key);
$$;

CREATE OR REPLACE FUNCTION public.hash_cpf(cpf text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog AS $$
  SELECT encode(digest(cpf, 'sha256'), 'hex');
$$;

REVOKE EXECUTE ON FUNCTION public.encrypt_cpf(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decrypt_cpf(bytea, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.hash_cpf(text)           FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.encrypt_cpf(text, text)  TO service_role;
GRANT  EXECUTE ON FUNCTION public.decrypt_cpf(bytea, text) TO service_role;
GRANT  EXECUTE ON FUNCTION public.hash_cpf(text)           TO service_role;

-- ─── Table: patients ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.patients (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           UUID        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  full_name           TEXT        NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
  preferred_name      TEXT,
  phone               TEXT        NOT NULL CHECK (phone ~ '^\+[1-9]\d{7,14}$'),
  email               TEXT,
  birth_date          DATE,
  gender              TEXT        CHECK (gender IN ('male', 'female', 'other', 'prefer_not_say')),
  encrypted_cpf       BYTEA,
  cpf_hash            TEXT,
  address             JSONB,
  emergency_contact   JSONB,
  medical_notes       TEXT,
  tags                TEXT[]      NOT NULL DEFAULT '{}',
  metadata            JSONB       NOT NULL DEFAULT '{}',
  source              TEXT        CHECK (source IN ('whatsapp', 'manual', 'imported', 'website')),
  created_by          UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  last_contact_at     TIMESTAMPTZ,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_patients_clinic_name
  ON public.patients (clinic_id, full_name)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_clinic_phone_unique
  ON public.patients (clinic_id, phone)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_clinic_cpf_hash_unique
  ON public.patients (clinic_id, cpf_hash)
  WHERE deleted_at IS NULL AND cpf_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_patients_clinic_created_at
  ON public.patients (clinic_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_patients_full_name_trgm
  ON public.patients USING gin (full_name gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_patients_tags
  ON public.patients USING gin (tags)
  WHERE deleted_at IS NULL;

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE TRIGGER trg_patients_updated_at
  BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patients FORCE ROW LEVEL SECURITY;

CREATE POLICY "patients: members can select"
  ON public.patients FOR SELECT
  USING (is_clinic_member(clinic_id) AND deleted_at IS NULL);

CREATE POLICY "patients: members can insert"
  ON public.patients FOR INSERT
  WITH CHECK (is_clinic_member(clinic_id));

CREATE POLICY "patients: members can update"
  ON public.patients FOR UPDATE
  USING  (is_clinic_member(clinic_id))
  WITH CHECK (is_clinic_member(clinic_id));

CREATE POLICY "patients: admins can delete"
  ON public.patients FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.patients TO authenticated;

-- ─── Soft-delete trigger ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.soft_delete_patient()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  UPDATE public.patients
  SET deleted_at = NOW()
  WHERE id = OLD.id AND deleted_at IS NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_patients_soft_delete
  BEFORE DELETE ON public.patients
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL)
  EXECUTE FUNCTION public.soft_delete_patient();

-- ─── Audit log trigger ────────────────────────────────────────────────────────
-- Never copies encrypted_cpf or cpf_hash into audit_logs metadata.

CREATE OR REPLACE FUNCTION public.audit_patient_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_action      text;
  v_after_data  jsonb;
  v_before_data jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action      := 'patient.created';
    v_after_data  := (to_jsonb(NEW) - 'encrypted_cpf' - 'cpf_hash');
    v_before_data := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
      v_action := 'patient.deleted';
    ELSE
      v_action := 'patient.updated';
    END IF;
    v_after_data  := (to_jsonb(NEW) - 'encrypted_cpf' - 'cpf_hash');
    v_before_data := (to_jsonb(OLD) - 'encrypted_cpf' - 'cpf_hash');
  END IF;

  INSERT INTO public.audit_logs (
    clinic_id, user_id, action, resource, resource_id, metadata
  ) VALUES (
    NEW.clinic_id,
    auth.uid(),
    v_action,
    'patients',
    NEW.id,
    jsonb_build_object('before', v_before_data, 'after', v_after_data)
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_patient_change
  AFTER INSERT OR UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.audit_patient_change();

-- ─── get_patient_cpf ─────────────────────────────────────────────────────────
-- The ONLY way for an authenticated user to obtain the decrypted CPF.
-- Requires admin or owner role for the patient's clinic.
-- Also writes an audit log entry so CPF access is tracked.

CREATE OR REPLACE FUNCTION public.get_patient_cpf(p_patient_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER
SET search_path = extensions, public, pg_catalog AS $$
DECLARE
  v_clinic_id UUID;
  v_encrypted BYTEA;
  v_key       TEXT;
BEGIN
  SELECT clinic_id, encrypted_cpf
  INTO   v_clinic_id, v_encrypted
  FROM   public.patients
  WHERE  id = p_patient_id
    AND  deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient not found';
  END IF;

  IF NOT has_clinic_role(v_clinic_id, 'admin')
     AND NOT has_clinic_role(v_clinic_id, 'owner')
  THEN
    RAISE EXCEPTION 'access denied: requires admin or owner role';
  END IF;

  IF v_encrypted IS NULL THEN
    RETURN NULL;
  END IF;

  v_key := current_setting('app.encryption_key', TRUE);
  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'app.encryption_key is not configured for this session';
  END IF;

  INSERT INTO public.audit_logs (
    clinic_id, user_id, action, resource, resource_id, metadata
  ) VALUES (
    v_clinic_id,
    auth.uid(),
    'patient.cpf_accessed',
    'patients',
    p_patient_id,
    '{}'::jsonb
  );

  RETURN pgp_sym_decrypt(v_encrypted, v_key);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_patient_cpf(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_patient_cpf(UUID) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_patient_cpf(UUID) TO service_role;

-- Trigger functions must not be callable via REST.
REVOKE EXECUTE ON FUNCTION public.audit_patient_change()   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.soft_delete_patient()    FROM PUBLIC, anon, authenticated;

-- Supabase individually grants anon/authenticated beyond PUBLIC revoke — close that gap.
REVOKE EXECUTE ON FUNCTION public.encrypt_cpf(text, text)  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.decrypt_cpf(bytea, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.hash_cpf(text)           FROM anon, authenticated;

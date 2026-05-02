-- ─── Encryption utilities ─────────────────────────────────────────────────────
-- Uses pgcrypto pgp_sym_encrypt/decrypt (already installed from 0000).
-- Key comes from session config: SET app.encryption_key = '...';

CREATE OR REPLACE FUNCTION public.encrypt_credential(plain text, key text)
RETURNS bytea LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog AS $$
  SELECT pgp_sym_encrypt(plain, key);
$$;

CREATE OR REPLACE FUNCTION public.decrypt_credential(encrypted bytea, key text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog AS $$
  SELECT pgp_sym_decrypt(encrypted, key);
$$;

-- Restrict encrypt/decrypt to service_role — authenticated users must go through
-- get_integration_credential which enforces role checks before decrypting.
REVOKE EXECUTE ON FUNCTION public.encrypt_credential(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decrypt_credential(bytea, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.encrypt_credential(text, text) TO service_role;
GRANT  EXECUTE ON FUNCTION public.decrypt_credential(bytea, text) TO service_role;

-- ─── Table: clinic_integrations ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.clinic_integrations (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id             UUID        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  type                  TEXT        NOT NULL
                                    CHECK (type IN ('pep', 'whatsapp', 'kapso', 'calcom', 'custom')),
  provider              TEXT        NOT NULL,
  name                  TEXT        NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'configuring'
                                    CHECK (status IN ('configuring', 'active', 'error', 'disabled')),
  config                JSONB       NOT NULL DEFAULT '{}',
  encrypted_credentials BYTEA,
  webhook_secret        TEXT,
  webhook_path          TEXT        GENERATED ALWAYS AS (
                                      '/api/webhooks/' || type || '/' || provider || '/' || clinic_id::text
                                    ) STORED,
  last_sync_at          TIMESTAMPTZ,
  last_error            TEXT,
  last_error_at         TIMESTAMPTZ,
  metadata              JSONB       NOT NULL DEFAULT '{}',
  deleted_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (clinic_id, type, provider, name)
    DEFERRABLE INITIALLY IMMEDIATE
);

-- Partial unique index: only one active (non-deleted) integration per clinic+type+provider+name
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_integrations_unique_active
  ON public.clinic_integrations (clinic_id, type, provider, name)
  WHERE deleted_at IS NULL;

-- updated_at trigger
CREATE TRIGGER trg_clinic_integrations_updated_at
  BEFORE UPDATE ON public.clinic_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_clinic_integrations_clinic_status
  ON public.clinic_integrations (clinic_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_clinic_integrations_clinic_type_provider
  ON public.clinic_integrations (clinic_id, type, provider)
  WHERE deleted_at IS NULL;

-- ─── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.clinic_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinic_integrations FORCE ROW LEVEL SECURITY;

CREATE POLICY "clinic_integrations: members can select"
  ON public.clinic_integrations FOR SELECT
  USING (is_clinic_member(clinic_id) AND deleted_at IS NULL);

CREATE POLICY "clinic_integrations: admins can insert"
  ON public.clinic_integrations FOR INSERT
  WITH CHECK (has_clinic_role(clinic_id, 'admin'));

CREATE POLICY "clinic_integrations: admins can update"
  ON public.clinic_integrations FOR UPDATE
  USING  (has_clinic_role(clinic_id, 'admin'))
  WITH CHECK (has_clinic_role(clinic_id, 'admin'));

CREATE POLICY "clinic_integrations: admins can delete"
  ON public.clinic_integrations FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin'));

-- Grant DML to authenticated (RLS policies control actual access)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clinic_integrations TO authenticated;

-- ─── Soft-delete trigger ──────────────────────────────────────────────────────
-- Intercepts DELETE, sets deleted_at = NOW(), cancels the actual DELETE.
-- SECURITY DEFINER so the internal UPDATE bypasses RLS (the DELETE policy
-- already guards who can initiate it).

CREATE OR REPLACE FUNCTION public.soft_delete_integration()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  UPDATE public.clinic_integrations
  SET deleted_at = NOW()
  WHERE id = OLD.id AND deleted_at IS NULL;
  RETURN NULL; -- Cancels the actual DELETE row operation
END;
$$;

CREATE TRIGGER trg_clinic_integrations_soft_delete
  BEFORE DELETE ON public.clinic_integrations
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL)
  EXECUTE FUNCTION public.soft_delete_integration();

-- ─── Audit log trigger ────────────────────────────────────────────────────────
-- Fires AFTER INSERT and AFTER UPDATE (soft DELETE becomes UPDATE via trigger above).
-- Never copies encrypted_credentials into metadata — strips it explicitly.

CREATE OR REPLACE FUNCTION public.audit_integration_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_action      text;
  v_after_data  jsonb;
  v_before_data jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action      := 'integration.created';
    v_after_data  := (to_jsonb(NEW) - 'encrypted_credentials');
    v_before_data := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
      v_action := 'integration.deleted';
    ELSIF NEW.status = 'active' AND OLD.status != 'active' THEN
      v_action := 'integration.activated';
    ELSIF NEW.status = 'error'  AND OLD.status != 'error'  THEN
      v_action := 'integration.errored';
    ELSE
      v_action := 'integration.updated';
    END IF;
    v_after_data  := (to_jsonb(NEW) - 'encrypted_credentials');
    v_before_data := (to_jsonb(OLD) - 'encrypted_credentials');
  END IF;

  INSERT INTO public.audit_logs (
    clinic_id, user_id, action, resource, resource_id, metadata
  ) VALUES (
    NEW.clinic_id,
    auth.uid(),
    v_action,
    'clinic_integrations',
    NEW.id,
    jsonb_build_object('before', v_before_data, 'after', v_after_data)
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_audit_integration_change
  AFTER INSERT OR UPDATE ON public.clinic_integrations
  FOR EACH ROW EXECUTE FUNCTION public.audit_integration_change();

-- ─── get_integration_credential ──────────────────────────────────────────────
-- The ONLY way for an authenticated user to obtain the decrypted credential.
-- Validates that the caller is an admin or owner of the clinic before decrypting.
-- Reads the encryption key from the session setting: SET app.encryption_key = '...';

CREATE OR REPLACE FUNCTION public.get_integration_credential(p_integration_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER
SET search_path = extensions, public, pg_catalog AS $$
DECLARE
  v_clinic_id UUID;
  v_encrypted BYTEA;
  v_key       TEXT;
BEGIN
  SELECT clinic_id, encrypted_credentials
  INTO   v_clinic_id, v_encrypted
  FROM   public.clinic_integrations
  WHERE  id = p_integration_id
    AND  deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'integration not found';
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

  RETURN pgp_sym_decrypt(v_encrypted, v_key);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_integration_credential(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_integration_credential(UUID) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.get_integration_credential(UUID) TO service_role;

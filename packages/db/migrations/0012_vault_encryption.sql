-- Migration 0012: replace app.encryption_key GUC with supabase_vault master secret.
-- Pre-requisite: secret named 'medina_master_encryption_key' exists in vault.secrets.
-- See plans/fix-encryption-vault.md for bootstrap instructions.

-- ─── Helper: read master key from vault ───────────────────────────────────────
-- Single source of truth for vault lookup. SECURITY DEFINER + qualified
-- references prevent schema-hijacking. STABLE because vault contents change
-- between transactions but not within one query.

CREATE OR REPLACE FUNCTION public._get_master_encryption_key()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_key text;
BEGIN
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'medina_master_encryption_key';

  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'master encryption key not found in vault (name=medina_master_encryption_key)';
  END IF;

  RETURN v_key;
END $$;

REVOKE EXECUTE ON FUNCTION public._get_master_encryption_key() FROM PUBLIC;
-- No GRANT to authenticated — only SECURITY DEFINER functions in public call this internally.

-- ─── Drop old key-parameter signatures ────────────────────────────────────────

DROP FUNCTION IF EXISTS public.encrypt_credential(text, text);
DROP FUNCTION IF EXISTS public.decrypt_credential(bytea, text);
DROP FUNCTION IF EXISTS public.encrypt_cpf(text, text);
DROP FUNCTION IF EXISTS public.decrypt_cpf(bytea, text);

-- ─── New no-key-parameter encrypt/decrypt ─────────────────────────────────────
-- VOLATILE on encrypt: pgp_sym_encrypt uses random IV → non-deterministic output.
-- STABLE on decrypt: deterministic given same vault state within a query.

CREATE FUNCTION public.encrypt_credential(plain text)
RETURNS bytea LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
BEGIN
  RETURN extensions.pgp_sym_encrypt(plain, public._get_master_encryption_key());
END $$;

CREATE FUNCTION public.decrypt_credential(encrypted bytea)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
BEGIN
  RETURN extensions.pgp_sym_decrypt(encrypted, public._get_master_encryption_key());
END $$;

CREATE FUNCTION public.encrypt_cpf(cpf text)
RETURNS bytea LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
BEGIN
  RETURN extensions.pgp_sym_encrypt(cpf, public._get_master_encryption_key());
END $$;

CREATE FUNCTION public.decrypt_cpf(encrypted bytea)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
BEGIN
  RETURN extensions.pgp_sym_decrypt(encrypted, public._get_master_encryption_key());
END $$;

REVOKE EXECUTE ON FUNCTION public.encrypt_credential(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decrypt_credential(bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.encrypt_cpf(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.decrypt_cpf(bytea) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.encrypt_credential(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_credential(bytea) TO service_role;
GRANT EXECUTE ON FUNCTION public.encrypt_cpf(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_cpf(bytea) TO service_role;

-- ─── Replace GUC-reading wrappers ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_integration_credential(p_integration_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
DECLARE
  v_clinic_id uuid;
  v_encrypted bytea;
BEGIN
  SELECT clinic_id, encrypted_credentials
  INTO v_clinic_id, v_encrypted
  FROM public.clinic_integrations
  WHERE id = p_integration_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'integration not found';
  END IF;

  IF NOT public.has_clinic_role(v_clinic_id, 'admin')
     AND NOT public.has_clinic_role(v_clinic_id, 'owner') THEN
    RAISE EXCEPTION 'access denied: requires admin or owner role';
  END IF;

  IF v_encrypted IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN extensions.pgp_sym_decrypt(v_encrypted, public._get_master_encryption_key());
END $$;

REVOKE EXECUTE ON FUNCTION public.get_integration_credential(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_integration_credential(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_patient_cpf(p_patient_id uuid)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
DECLARE
  v_clinic_id uuid;
  v_encrypted bytea;
BEGIN
  SELECT clinic_id, encrypted_cpf
  INTO v_clinic_id, v_encrypted
  FROM public.patients
  WHERE id = p_patient_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient not found';
  END IF;

  IF NOT public.has_clinic_role(v_clinic_id, 'admin')
     AND NOT public.has_clinic_role(v_clinic_id, 'owner') THEN
    RAISE EXCEPTION 'access denied: requires admin or owner role';
  END IF;

  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (v_clinic_id, (SELECT auth.uid()), 'patient.cpf_accessed', 'patients', p_patient_id, '{}'::jsonb);

  IF v_encrypted IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN extensions.pgp_sym_decrypt(v_encrypted, public._get_master_encryption_key());
END $$;

REVOKE EXECUTE ON FUNCTION public.get_patient_cpf(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_patient_cpf(uuid) TO authenticated, service_role;

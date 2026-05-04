-- ════════════════════════════════════════════════════════════════════════════
-- 0015_get_integration_credential_internal.sql
--
-- Worker-only variant of get_integration_credential without the
-- has_clinic_role check. Required because Inngest workers run with
-- service_role JWT, which makes auth.uid() return NULL and fails the role
-- check inside the user-facing function (introduced in 0012:96-99).
--
-- Security model:
--   - SECURITY DEFINER + explicit search_path (matches 0012 pattern).
--   - REVOKE EXECUTE from PUBLIC + authenticated + anon.
--   - GRANT EXECUTE only to service_role.
--   - service_role JWT is only used server-side (Inngest worker, webhook
--     handlers); never exposed to clients via supabase-js anon/authenticated
--     paths.
--   - The user-facing get_integration_credential remains untouched and still
--     enforces admin/owner role for direct UI/RPC calls.
--
-- Mirrors the GRANT pattern of decrypt_credential(bytea) which is already
-- service_role-only since 0012:74.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_integration_credential_internal(p_integration_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = extensions, public, pg_catalog, pg_temp AS $$
DECLARE
  v_encrypted bytea;
BEGIN
  SELECT encrypted_credentials INTO v_encrypted
  FROM public.clinic_integrations
  WHERE id = p_integration_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'integration not found';
  END IF;

  IF v_encrypted IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN extensions.pgp_sym_decrypt(v_encrypted, public._get_master_encryption_key());
END $$;

REVOKE EXECUTE ON FUNCTION public.get_integration_credential_internal(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_integration_credential_internal(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_integration_credential_internal(uuid) TO service_role;

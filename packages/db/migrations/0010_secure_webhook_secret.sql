-- ─── Secure webhook_secret: column-level grant ────────────────────────────────
-- BEFORE: authenticated can SELECT * (including webhook_secret and encrypted_credentials).
-- AFTER:  authenticated can SELECT only safe metadata columns.
--         service_role still reads full table (bypasses RLS + grants).
--         Admins access webhook_secret via get_integration_credential() only.
--
-- Pattern: revoke table-level SELECT, re-grant per safe column, add helper view.

-- Step 1: Revoke broad SELECT; keep INSERT/UPDATE/DELETE intact
REVOKE SELECT ON public.clinic_integrations FROM authenticated;

GRANT SELECT (
  id, clinic_id, type, provider, name, status, config, webhook_path,
  last_sync_at, last_error, last_error_at, metadata, deleted_at, created_at, updated_at
) ON public.clinic_integrations TO authenticated;

-- Step 2: Safe view for listing integrations (members use this, not the base table)
-- security_invoker=true ensures the view enforces RLS as the querying user,
-- not as the view owner (postgres). Without this, Supabase linter flags it as
-- an implicit SECURITY DEFINER view (ERROR), which would bypass RLS.
CREATE OR REPLACE VIEW public.clinic_integrations_safe
WITH (security_invoker = true) AS
SELECT
  id, clinic_id, type, provider, name, status, config, webhook_path,
  last_sync_at, last_error, last_error_at, metadata, deleted_at, created_at, updated_at
FROM public.clinic_integrations;

GRANT SELECT ON public.clinic_integrations_safe TO authenticated;
REVOKE ALL ON public.clinic_integrations_safe FROM anon;

-- Step 3: Enforce that active integrations must have a webhook_secret
ALTER TABLE public.clinic_integrations
  ADD CONSTRAINT clinic_integrations_active_requires_secret
  CHECK (status != 'active' OR webhook_secret IS NOT NULL);

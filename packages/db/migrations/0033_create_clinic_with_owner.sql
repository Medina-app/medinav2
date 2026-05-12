-- 0033_create_clinic_with_owner.sql
--
-- Issue PR-D #10 (post-push backlog B2): onboarding atomicidade.
-- Antes: createClinicAction fazia INSERT clinics então INSERT clinic_members
-- em duas chamadas separadas + cleanup manual (DELETE clinic) se o segundo
-- falhasse. Window de inconsistência se o processo morresse entre os dois
-- inserts ou se o cleanup falhasse.
--
-- Solução: RPC SECURITY DEFINER atômica. clinic + member num só body de
-- função (transação implícita). Falha em qualquer passo -> ROLLBACK
-- automático, nenhuma clinic órfã.
--
-- Service_role only: chamada exclusivamente por createClinicAction
-- (server-side com admin client). Não expor via REST público.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_clinic_with_owner(
  p_name    text,
  p_slug    text,
  p_user_id uuid
)
RETURNS TABLE (id uuid, slug text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_clinic_id uuid;
BEGIN
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'p_name must be non-empty';
  END IF;
  IF p_slug IS NULL OR length(trim(p_slug)) = 0 THEN
    RAISE EXCEPTION 'p_slug must be non-empty';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id must not be null';
  END IF;

  INSERT INTO public.clinics (name, slug)
  VALUES (p_name, p_slug)
  RETURNING clinics.id INTO v_clinic_id;

  INSERT INTO public.clinic_members (clinic_id, user_id, role)
  VALUES (v_clinic_id, p_user_id, 'owner');

  RETURN QUERY SELECT v_clinic_id, p_slug;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_clinic_with_owner(text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_clinic_with_owner(text, text, uuid)
  TO service_role;

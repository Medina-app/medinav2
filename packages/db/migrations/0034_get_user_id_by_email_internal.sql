-- 0034_get_user_id_by_email_internal.sql
--
-- Issue PR-D #9 (post-push backlog B1): listUsers() em inviteMemberAction
-- fetcha TODOS os users da plataforma sem paginação, OOM risk a partir de
-- ~1k users.
--
-- Substitui pelo lookup O(1) direto: SELECT id FROM auth.users WHERE email=?
-- via RPC SECURITY DEFINER. auth.users é tabela protegida do schema 'auth'
-- — só service_role acessa; RPC encapsula o pattern e expõe um único
-- user_id (ou NULL quando não encontrado).
--
-- Normalização do email: lower(trim()) garante match case-insensitive
-- consistente com como Supabase armazena emails em auth.users (normaliza
-- pra lowercase no signup). Antes, listUsers + Array.find(u.email===email)
-- era case-sensitive — qualquer mismatch de case retornava "user not found".
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_user_id_by_email_internal(p_email text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, auth, public, pg_temp AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF p_email IS NULL OR length(trim(p_email)) = 0 THEN
    RAISE EXCEPTION 'p_email must be non-empty';
  END IF;

  SELECT id INTO v_user_id
  FROM auth.users
  WHERE email = lower(trim(p_email))
    AND deleted_at IS NULL
  LIMIT 1;

  RETURN v_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_user_id_by_email_internal(text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_user_id_by_email_internal(text)
  TO service_role;

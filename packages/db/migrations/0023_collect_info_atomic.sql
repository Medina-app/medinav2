-- ════════════════════════════════════════════════════════════════════════════
-- 0023_collect_info_atomic.sql
--
-- Issue #12 follow-up: collect-info tool fazia read-modify-write em
-- conversations.metadata.collected_info sem lock. Race condition teorica
-- com 2 dispatches paralelos: ambos leem metadata, ambos calculam next
-- com seu novo field, ambos escrevem -> last-writer-wins, primeiro field
-- perdido.
--
-- Em prod, dispatch e single-threaded por conversation (Inngest event
-- processing), entao race era teorica. Mitigacao definitiva via RPC:
-- jsonb_set com FOR UPDATE lock garante atomicidade independente do
-- caller pattern.
--
-- Service_role only (mirrors pattern PR-A 0018-0020 + AI-5 0021-0022):
-- so dispatcher chama via tool, nunca exposto no PostgREST publico.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.collect_info_atomic(
  p_conversation_id uuid,
  p_clinic_id       uuid,
  p_field           text,
  p_value           text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_clinic uuid;
  v_collected jsonb;
BEGIN
  IF p_field IS NULL OR length(trim(p_field)) = 0 THEN
    RAISE EXCEPTION 'p_field must be non-empty';
  END IF;
  IF p_value IS NULL THEN
    RAISE EXCEPTION 'p_value must not be null';
  END IF;

  -- Lock conversation row pra serializar concurrent updates do mesmo
  -- conversation_id (postgres row locks; segunda tx espera commit, le
  -- estado atualizado, jsonb_set merge o seu field sem perder o anterior).
  SELECT clinic_id INTO v_clinic
  FROM public.conversations
  WHERE id = p_conversation_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
  END IF;

  IF v_clinic IS DISTINCT FROM p_clinic_id THEN
    RAISE EXCEPTION 'cross-tenant violation: conversation % belongs to %, not %',
      p_conversation_id, v_clinic, p_clinic_id;
  END IF;

  -- jsonb_set com create_missing=true cobre tres casos:
  -- (a) metadata IS NULL -> COALESCE -> '{}', then path collected_info.field
  -- (b) collected_info nao existe -> create
  -- (c) collected_info.field existente -> overwrite com novo timestamp
  UPDATE public.conversations
  SET    metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           ARRAY['collected_info', p_field],
           to_jsonb(p_value),
           true
         ),
         updated_at = NOW()
  WHERE  id = p_conversation_id;

  SELECT metadata->'collected_info' INTO v_collected
  FROM public.conversations
  WHERE id = p_conversation_id;

  RETURN COALESCE(v_collected, '{}'::jsonb);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.collect_info_atomic(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.collect_info_atomic(uuid,uuid,text,text) TO service_role;

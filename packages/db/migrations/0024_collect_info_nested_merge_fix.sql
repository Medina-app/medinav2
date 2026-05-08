-- ════════════════════════════════════════════════════════════════════════════
-- 0024_collect_info_nested_merge_fix.sql
--
-- 0023 introduziu collect_info_atomic via jsonb_set com create_missing=true,
-- mas jsonb_set NAO cria intermediate keys ausentes -- apenas a leaf-level.
-- Quando metadata={} (default), path=['collected_info', p_field], parent
-- 'collected_info' nao existe, jsonb_set retorna metadata inalterado.
--
-- Fix: usar operator || (jsonb merge) com jsonb_build_object pra controle
-- explicito de cada nivel:
--
--   metadata := metadata || {'collected_info': existing_collected_info || {field: value}}
--
-- Top-level || mescla 'collected_info' (substitui se existir, adiciona se nao).
-- Inner || mescla o field (substitui timestamp anterior se field ja coletado,
-- adiciona se primeiro). Ambos COALESCE pra '{}' garantem null-safety.
--
-- Forward-only via CREATE OR REPLACE.
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

  -- Nested merge via || operator. Funciona quando collected_info ainda nao
  -- existe (jsonb_set teria falhado silenciosamente).
  UPDATE public.conversations
  SET    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'collected_info',
           COALESCE(metadata->'collected_info', '{}'::jsonb) ||
             jsonb_build_object(p_field, to_jsonb(p_value))
         ),
         updated_at = NOW()
  WHERE  id = p_conversation_id;

  SELECT metadata->'collected_info' INTO v_collected
  FROM public.conversations
  WHERE id = p_conversation_id;

  RETURN COALESCE(v_collected, '{}'::jsonb);
END;
$$;

-- Grants/revokes preservados de 0023 (CREATE OR REPLACE não os reseta).

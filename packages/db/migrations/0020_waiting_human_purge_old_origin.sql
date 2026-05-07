-- ════════════════════════════════════════════════════════════════════════════
-- 0020_waiting_human_purge_old_origin.sql
--
-- PR-A follow-up to 0019 (CodeRabbit re-review finding, Major).
-- Forward-only via CREATE OR REPLACE on the 2 transition_conversation_state
-- overloads. escalate_conversation unchanged (delegates to 4-arg).
--
-- Problem identified by CodeRabbit:
--   The 0019 COALESCE(escalated_via, 'manual') in 3-arg and
--   COALESCE(escalated_via_value, escalated_via, 'manual') in 4-arg preserved
--   the OLD escalated_via when transitioning to waiting_human, leading to
--   stale 'ai' on legitimate manual reescalations:
--
--     ai_handling --escalate_conversation--> waiting_human (escalated_via='ai')
--                 --transition->'assigned'--> assigned (preserved 'ai' via ELSE)
--                 --transition->'waiting_human' (3-arg)--> waiting_human
--                                                        (preserved 'ai' STALE)
--
--   The atendente devolveu a conversa via 3-arg and the badge stays "🤖 IA
--   escalou" instead of switching to "👤 Atendente assumiu".
--
--   Additionally, the 3-arg audit_logs entry only recorded `state`, not
--   `escalated_via`, so the audit trail diverged from the persisted row.
--
-- Semântica explícita após 0020:
--   3-arg: sempre marca 'manual' em waiting_human (caller que não fornece
--          origem é assumido manual). Audit_logs.after ganha escalated_via.
--   4-arg: COALESCE(escalated_via_value, 'manual') — explicit value or default;
--          NÃO usa v_old_escalated_via como fallback (purge old origin).
--   escalate_conversation: inalterado; passa 'ai' explicit pra 4-arg.
--
-- Resultado: só escalate_conversation (via 4-arg com 'ai') pode marcar 'ai'.
-- Todo outro path pra waiting_human marca 'manual' (default seguro).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 3-arg transition_conversation_state ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.transition_conversation_state(
  conv_id   uuid,
  new_state text,
  reason    text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_old_state         text;
  v_clinic_id         uuid;
  v_old_escalated_via text;
  v_new_escalated_via text;
  v_allowed           text[];
BEGIN
  SELECT state, clinic_id, escalated_via
  INTO   v_old_state, v_clinic_id, v_old_escalated_via
  FROM   public.conversations
  WHERE  id = conv_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
  END IF;

  IF (SELECT auth.uid()) IS NOT NULL AND NOT public.is_clinic_member(v_clinic_id) THEN
    RAISE EXCEPTION 'cross-tenant violation: caller is not member of clinic %', v_clinic_id;
  END IF;

  v_allowed := CASE v_old_state
    WHEN 'ai_handling'                THEN ARRAY['awaiting_template_response','waiting_human','paused','resolved']
    WHEN 'awaiting_template_response' THEN ARRAY['ai_handling','waiting_human','resolved']
    WHEN 'waiting_human'              THEN ARRAY['assigned','ai_handling','paused','resolved']
    WHEN 'assigned'                   THEN ARRAY['ai_handling','waiting_human','paused','resolved']
    WHEN 'paused'                     THEN ARRAY['ai_handling','waiting_human','resolved']
    WHEN 'resolved'                   THEN ARRAY[]::text[]
    ELSE                                   ARRAY[]::text[]
  END;

  IF NOT (new_state = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'Invalid state transition from % to %', v_old_state, new_state;
  END IF;

  -- 3-arg has no explicit escalated_via input; assume 'manual' for any
  -- waiting_human transition (purges stale 'ai' from earlier flows).
  v_new_escalated_via := CASE
    WHEN new_state = 'waiting_human' THEN 'manual'
    WHEN new_state = 'ai_handling'   THEN NULL
    ELSE v_old_escalated_via
  END;

  UPDATE public.conversations
  SET    state         = new_state,
         escalated_via = v_new_escalated_via,
         updated_at    = NOW()
  WHERE  id = conv_id;

  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    (SELECT auth.uid()),
    'conversation.state_changed',
    'conversations',
    conv_id,
    jsonb_build_object(
      'before', jsonb_build_object('state', v_old_state, 'escalated_via', v_old_escalated_via),
      'after',  jsonb_build_object('state', new_state, 'escalated_via', v_new_escalated_via),
      'reason', reason
    )
  );
END;
$$;

-- ─── 4-arg transition_conversation_state ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.transition_conversation_state(
  conv_id              uuid,
  new_state            text,
  reason               text,
  escalated_via_value  text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_old_state         text;
  v_clinic_id         uuid;
  v_old_escalated_via text;
  v_new_escalated_via text;
  v_allowed           text[];
BEGIN
  IF escalated_via_value IS NOT NULL
     AND escalated_via_value NOT IN ('ai', 'manual') THEN
    RAISE EXCEPTION 'escalated_via_value must be NULL, ''ai'' or ''manual''';
  END IF;

  SELECT state, clinic_id, escalated_via
  INTO   v_old_state, v_clinic_id, v_old_escalated_via
  FROM   public.conversations
  WHERE  id = conv_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
  END IF;

  IF (SELECT auth.uid()) IS NOT NULL AND NOT public.is_clinic_member(v_clinic_id) THEN
    RAISE EXCEPTION 'cross-tenant violation: caller is not member of clinic %', v_clinic_id;
  END IF;

  v_allowed := CASE v_old_state
    WHEN 'ai_handling'                THEN ARRAY['awaiting_template_response','waiting_human','paused','resolved']
    WHEN 'awaiting_template_response' THEN ARRAY['ai_handling','waiting_human','resolved']
    WHEN 'waiting_human'              THEN ARRAY['assigned','ai_handling','paused','resolved']
    WHEN 'assigned'                   THEN ARRAY['ai_handling','waiting_human','paused','resolved']
    WHEN 'paused'                     THEN ARRAY['ai_handling','waiting_human','resolved']
    WHEN 'resolved'                   THEN ARRAY[]::text[]
    ELSE                                   ARRAY[]::text[]
  END;

  IF NOT (new_state = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'Invalid state transition from % to %', v_old_state, new_state;
  END IF;

  -- 4-arg uses explicit value when provided, defaults to 'manual' on
  -- waiting_human (no fallback to v_old_escalated_via — old origin is purged).
  v_new_escalated_via := CASE
    WHEN new_state = 'waiting_human' THEN COALESCE(escalated_via_value, 'manual')
    WHEN new_state = 'ai_handling'   THEN NULL
    ELSE v_old_escalated_via
  END;

  UPDATE public.conversations
  SET    state         = new_state,
         escalated_via = v_new_escalated_via,
         updated_at    = NOW()
  WHERE  id = conv_id;

  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    (SELECT auth.uid()),
    'conversation.state_changed',
    'conversations',
    conv_id,
    jsonb_build_object(
      'before', jsonb_build_object('state', v_old_state, 'escalated_via', v_old_escalated_via),
      'after',  jsonb_build_object('state', new_state, 'escalated_via', v_new_escalated_via),
      'reason', reason
    )
  );
END;
$$;

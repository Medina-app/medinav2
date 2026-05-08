-- ════════════════════════════════════════════════════════════════════════════
-- 0022_clear_reason_on_ai_handling.sql
--
-- AI-5 follow-up: 0021 adicionou escalated_reason + 5-arg overload com
-- semântica de clear-on-ai_handling. Mas 3-arg e 4-arg overloads (de PR-A
-- 0019/0020) NÃO mexiam em escalated_reason, deixando valor stale quando
-- atendente devolvia a conversa pra IA via UI (3-arg path).
--
-- Cenário stale (sem este patch):
--   1. Pre-filter dispara → escalate_conversation_with_reason marca
--      escalated_via='ai', escalated_reason='medication', state=waiting_human
--   2. Atendente assume (5-arg lateral move) → state=assigned,
--      escalated_via='manual', escalated_reason='medication' (preservado, OK)
--   3. Atendente devolve via UI toggle (3-arg ai_handling) →
--      state=ai_handling, escalated_via=NULL, escalated_reason='medication'
--      (STALE — deveria ser NULL, simétrico ao escalated_via)
--
-- Fix: 3-arg e 4-arg agora também zeram escalated_reason quando new_state =
-- 'ai_handling'. Outros estados preservam (sem mudança comportamental).
-- 5-arg já fazia isso desde 0021 — sem alteração.
--
-- Forward-only via CREATE OR REPLACE; sem mudança de assinatura, sem novos
-- grants/revokes (herdados de 0019/0020).
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
  v_old_state            text;
  v_clinic_id            uuid;
  v_old_escalated_via    text;
  v_old_escalated_reason text;
  v_new_escalated_via    text;
  v_new_escalated_reason text;
  v_allowed              text[];
BEGIN
  SELECT state, clinic_id, escalated_via, escalated_reason
  INTO   v_old_state, v_clinic_id, v_old_escalated_via, v_old_escalated_reason
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

  -- 3-arg sempre marca 'manual' em waiting_human (caller que não fornece
  -- origem é assumido manual). Inalterado de 0020.
  v_new_escalated_via := CASE
    WHEN new_state = 'waiting_human' THEN 'manual'
    WHEN new_state = 'ai_handling'   THEN NULL
    ELSE v_old_escalated_via
  END;

  -- AI-5 0022 NEW: 3-arg agora limpa escalated_reason em ai_handling
  -- (simétrico ao escalated_via). Outros estados preservam.
  v_new_escalated_reason := CASE
    WHEN new_state = 'ai_handling' THEN NULL
    ELSE v_old_escalated_reason
  END;

  UPDATE public.conversations
  SET    state            = new_state,
         escalated_via    = v_new_escalated_via,
         escalated_reason = v_new_escalated_reason,
         updated_at       = NOW()
  WHERE  id = conv_id;

  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    (SELECT auth.uid()),
    'conversation.state_changed',
    'conversations',
    conv_id,
    jsonb_build_object(
      'before', jsonb_build_object(
        'state', v_old_state,
        'escalated_via', v_old_escalated_via,
        'escalated_reason', v_old_escalated_reason
      ),
      'after',  jsonb_build_object(
        'state', new_state,
        'escalated_via', v_new_escalated_via,
        'escalated_reason', v_new_escalated_reason
      ),
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
  v_old_state            text;
  v_clinic_id            uuid;
  v_old_escalated_via    text;
  v_old_escalated_reason text;
  v_new_escalated_via    text;
  v_new_escalated_reason text;
  v_allowed              text[];
BEGIN
  IF escalated_via_value IS NOT NULL
     AND escalated_via_value NOT IN ('ai', 'manual') THEN
    RAISE EXCEPTION 'escalated_via_value must be NULL, ''ai'' or ''manual''';
  END IF;

  SELECT state, clinic_id, escalated_via, escalated_reason
  INTO   v_old_state, v_clinic_id, v_old_escalated_via, v_old_escalated_reason
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

  v_new_escalated_via := CASE
    WHEN new_state = 'waiting_human' THEN COALESCE(escalated_via_value, 'manual')
    WHEN new_state = 'ai_handling'   THEN NULL
    ELSE v_old_escalated_via
  END;

  -- AI-5 0022 NEW: 4-arg agora limpa escalated_reason em ai_handling
  -- (simétrico ao escalated_via). 4-arg não recebe escalated_reason_value
  -- como input — preserva em outros estados, zera em ai_handling.
  v_new_escalated_reason := CASE
    WHEN new_state = 'ai_handling' THEN NULL
    ELSE v_old_escalated_reason
  END;

  UPDATE public.conversations
  SET    state            = new_state,
         escalated_via    = v_new_escalated_via,
         escalated_reason = v_new_escalated_reason,
         updated_at       = NOW()
  WHERE  id = conv_id;

  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    (SELECT auth.uid()),
    'conversation.state_changed',
    'conversations',
    conv_id,
    jsonb_build_object(
      'before', jsonb_build_object(
        'state', v_old_state,
        'escalated_via', v_old_escalated_via,
        'escalated_reason', v_old_escalated_reason
      ),
      'after',  jsonb_build_object(
        'state', new_state,
        'escalated_via', v_new_escalated_via,
        'escalated_reason', v_new_escalated_reason
      ),
      'reason', reason
    )
  );
END;
$$;

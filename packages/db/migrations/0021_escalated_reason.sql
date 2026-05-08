-- ════════════════════════════════════════════════════════════════════════════
-- 0021_escalated_reason.sql
--
-- AI-5: structured escalation reason category for guardrail-driven escalations.
-- Adds conversations.escalated_reason TEXT (CHECK enum) + 5-arg overload of
-- transition_conversation_state + new escalate_conversation_with_reason RPC
-- (service_role only, mirrors PR-A 0018-0020 pattern).
--
-- Backward-compat:
--   - 3-arg + 4-arg transition_conversation_state continue to exist (PR-A path
--     for tool-call escalations and manual toggles). They store
--     escalated_reason=NULL on waiting_human transitions because tool-call has
--     no structured category by design (LLM produces free-text reason).
--   - Existing escalate_conversation (3-arg) RPC is unchanged — used by
--     escalate_to_human tool. Sets escalated_via='ai', escalated_reason=NULL.
--
-- Semantics after 0021:
--   escalate_conversation              → via='ai',  reason=NULL  (tool-call path)
--   escalate_conversation_with_reason  → via='ai',  reason=<cat> (guardrail path)
--   transition (3-arg)                 → via='manual', reason=NULL (UI toggle)
--   transition (4-arg via='ai')        → reason=NULL  (legacy escalate path)
--   transition (5-arg)                 → reason=<cat>|NULL (guardrail delegate)
--
-- Schema-migration-checklist self-check:
--   ✓ (SELECT auth.uid()) usado no tenant guard
--   ✓ FK cross-tenant: explicit p_clinic_id check em escalate_with_reason
--   ✓ SECURITY DEFINER + search_path explícito em ambas funções
--   ✓ Sem SET parametrizado
--   ✓ Forward references: 5-arg criada antes do RPC que a chama
--   ✓ audit_logs.user_id NULL ok (service_role caller)
--   ✓ Backfill: NULL deliberado (rows existentes não têm categoria estruturada)
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Column: conversations.escalated_reason ─────────────────────────────────

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS escalated_reason TEXT;

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_escalated_reason_valid;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_escalated_reason_valid
  CHECK (
    escalated_reason IS NULL
    OR escalated_reason IN ('medication','diagnosis','urgency','symptom','other')
  );

-- ─── 5-arg transition_conversation_state (NEW overload) ─────────────────────
-- Sem DEFAULT nos args 3-5 pra evitar ambiguidade com 3-arg/4-arg overloads.
-- Postgres resolve por arity exato.

CREATE OR REPLACE FUNCTION public.transition_conversation_state(
  conv_id                uuid,
  new_state              text,
  reason                 text,
  escalated_via_value    text,
  escalated_reason_value text
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
  IF escalated_reason_value IS NOT NULL
     AND escalated_reason_value NOT IN ('medication','diagnosis','urgency','symptom','other') THEN
    RAISE EXCEPTION 'escalated_reason_value invalid: %', escalated_reason_value;
  END IF;

  SELECT state, clinic_id, escalated_via, escalated_reason
  INTO   v_old_state, v_clinic_id, v_old_escalated_via, v_old_escalated_reason
  FROM   public.conversations
  WHERE  id = conv_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
  END IF;

  -- Tenant guard for authenticated callers; service_role bypasses (auth.uid()=NULL).
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

  -- escalated_via: same default semantics as 4-arg (purge old origin).
  v_new_escalated_via := CASE
    WHEN new_state = 'waiting_human' THEN COALESCE(escalated_via_value, 'manual')
    WHEN new_state = 'ai_handling'   THEN NULL
    ELSE v_old_escalated_via
  END;

  -- escalated_reason: only meaningful while in waiting_human; clears on
  -- ai_handling; preserves on lateral moves (waiting_human → assigned, etc).
  v_new_escalated_reason := CASE
    WHEN new_state = 'waiting_human' THEN escalated_reason_value
    WHEN new_state = 'ai_handling'   THEN NULL
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

REVOKE EXECUTE ON FUNCTION public.transition_conversation_state(uuid,text,text,text,text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.transition_conversation_state(uuid,text,text,text,text) TO authenticated;

-- ─── escalate_conversation_with_reason (NEW — service_role only) ────────────

CREATE OR REPLACE FUNCTION public.escalate_conversation_with_reason(
  p_conversation_id uuid,
  p_clinic_id       uuid,
  p_reason          text,
  p_reason_category text  -- 'medication'|'diagnosis'|'urgency'|'symptom'|'other'
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_old_state   text;
  v_clinic_id   uuid;
  v_msg_content text;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'reason must be at least 3 chars';
  END IF;
  IF p_reason_category NOT IN ('medication','diagnosis','urgency','symptom','other') THEN
    RAISE EXCEPTION 'p_reason_category invalid: %', p_reason_category;
  END IF;

  -- FOR UPDATE: serializes concurrent calls; second tx waits, re-reads
  -- waiting_human, falls into idempotency branch.
  SELECT state, clinic_id INTO v_old_state, v_clinic_id
  FROM public.conversations
  WHERE id = p_conversation_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
  END IF;

  IF v_clinic_id IS DISTINCT FROM p_clinic_id THEN
    RAISE EXCEPTION 'cross-tenant violation: conversation % belongs to %, not %',
      p_conversation_id, v_clinic_id, p_clinic_id;
  END IF;

  IF v_old_state = 'waiting_human' THEN
    RETURN false;  -- idempotent
  END IF;

  -- Delega state + escalated_via='ai' + escalated_reason via 5-arg.
  -- Re-locks same row (re-entrant within same Tx). Tenant guard inside is
  -- bypassed because this RPC is service_role-only (auth.uid() = NULL).
  PERFORM public.transition_conversation_state(
    p_conversation_id, 'waiting_human', p_reason, 'ai', p_reason_category
  );

  -- System message: 🛡️ prefix distinguishes guardrail-driven from tool-call (🤖).
  v_msg_content := '🛡️ IA escalou (' || p_reason_category || '): ' || p_reason;

  INSERT INTO public.messages
    (clinic_id, conversation_id, direction, sender_type, content_type,
     content, delivery_status, outbox_status)
  VALUES
    (v_clinic_id, p_conversation_id, 'outbound', 'system', 'system',
     v_msg_content, 'sent', NULL);

  -- Audit specific to guardrail path (parallel to state_changed from transition).
  INSERT INTO public.audit_logs
    (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    (SELECT auth.uid()),
    'agent.guardrail.escalate',
    'conversations',
    p_conversation_id,
    jsonb_build_object(
      'reason',   p_reason,
      'category', p_reason_category,
      'source',   'ai'
    )
  );

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.escalate_conversation_with_reason(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.escalate_conversation_with_reason(uuid,uuid,text,text) TO service_role;

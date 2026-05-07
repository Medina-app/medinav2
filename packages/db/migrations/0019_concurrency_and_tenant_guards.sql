-- ════════════════════════════════════════════════════════════════════════════
-- 0019_concurrency_and_tenant_guards.sql
--
-- PR-A follow-up: applies 4 CodeRabbit findings on top of 0018 (which is
-- already deployed in prod, hence forward-only via CREATE OR REPLACE on the
-- 3 functions instead of editing 0018).
--
-- Fixes applied:
--   #1 (Critical) Race condition in SELECT -> UPDATE pattern:
--       Two concurrent transactions could both pass the idempotency/state
--       check and double-insert side effects (system message, audit_logs).
--       Mitigation: SELECT ... FOR UPDATE on the initial row read in all
--       3 functions. PostgreSQL row locks are re-entrant within the same
--       transaction, so escalate_conversation -> PERFORM transition (which
--       also locks) is a noop on the second lock — same Tx already owns it.
--       Concurrent escalate_conversation calls now serialize: second tx waits
--       for first commit, re-reads state='waiting_human', and falls into the
--       idempotency branch returning false.
--
--   #2 (Critical) transition_conversation_state SECURITY DEFINER without
--       tenant guard exposed to authenticated role:
--       Any authenticated user who knew a conversation_id could transition
--       state for another clinic via direct PostgREST RPC call (the caller
--       layer guard in toggleAiHandlingAction only protects the UI path).
--       Mitigation: explicit is_clinic_member(v_clinic_id) check inside both
--       overloads, scoped to authenticated callers only. service_role bypass
--       is preserved via the (SELECT auth.uid()) IS NOT NULL short-circuit
--       (service_role JWT yields NULL auth.uid()), so Inngest workers and
--       escalate_conversation -> PERFORM transition continue to work.
--
--   #3 (Major) waiting_human reachable without reliable escalated_via:
--       3-arg overload didn't touch escalated_via at all when transitioning
--       to waiting_human (left stale or NULL). 4-arg overload left it
--       unchanged when escalated_via_value was NULL. Both reopened the
--       null/stale origin gap that the new column was supposed to close.
--       Mitigation: COALESCE defaults — when new_state='waiting_human',
--         3-arg: COALESCE(escalated_via, 'manual')
--         4-arg: COALESCE(escalated_via_value, escalated_via, 'manual')
--       Both default to 'manual' when no other source is available, so the
--       UI badge and reporting always have a non-null origin.
--
-- escalate_conversation also gets FOR UPDATE on its initial SELECT so the
-- idempotency check is stable under concurrency. Tenant guard inside it
-- is unchanged (already validates p_clinic_id == conversation.clinic_id).
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
  v_old_state text;
  v_clinic_id uuid;
  v_allowed   text[];
BEGIN
  -- Fix #1: lock row to serialize concurrent transitions.
  SELECT state, clinic_id INTO v_old_state, v_clinic_id
  FROM public.conversations
  WHERE id = conv_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
  END IF;

  -- Fix #2: tenant guard for authenticated callers only.
  -- service_role bypasses (auth.uid() returns NULL).
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

  UPDATE public.conversations
  SET    state         = new_state,
         escalated_via = CASE
           -- Fix #3: waiting_human always has a non-null origin.
           WHEN new_state = 'waiting_human' THEN COALESCE(escalated_via, 'manual')
           WHEN new_state = 'ai_handling'   THEN NULL
           ELSE escalated_via
         END,
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
      'before', jsonb_build_object('state', v_old_state),
      'after',  jsonb_build_object('state', new_state),
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
  v_allowed           text[];
  v_old_escalated_via text;
  v_new_escalated_via text;
BEGIN
  IF escalated_via_value IS NOT NULL
     AND escalated_via_value NOT IN ('ai', 'manual') THEN
    RAISE EXCEPTION 'escalated_via_value must be NULL, ''ai'' or ''manual''';
  END IF;

  -- Fix #1: lock row.
  SELECT state, clinic_id, escalated_via
  INTO   v_old_state, v_clinic_id, v_old_escalated_via
  FROM   public.conversations
  WHERE  id = conv_id AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
  END IF;

  -- Fix #2: tenant guard (authenticated only).
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

  -- Fix #3: compute effective escalated_via with default for waiting_human.
  v_new_escalated_via := CASE
    WHEN new_state = 'waiting_human'
      THEN COALESCE(escalated_via_value, v_old_escalated_via, 'manual')
    WHEN new_state = 'ai_handling'
      THEN NULL
    ELSE v_old_escalated_via
  END;

  UPDATE public.conversations
  SET    state         = new_state,
         escalated_via = v_new_escalated_via,
         updated_at    = NOW()
  WHERE  id = conv_id;

  -- Audit registers the EFFECTIVE value (post-default), not raw input,
  -- so reporting reflects what's stored in the conversation.
  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    (SELECT auth.uid()),
    'conversation.state_changed',
    'conversations',
    conv_id,
    jsonb_build_object(
      'before', jsonb_build_object('state', v_old_state),
      'after',  jsonb_build_object('state', new_state, 'escalated_via', v_new_escalated_via),
      'reason', reason
    )
  );
END;
$$;

-- ─── escalate_conversation ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.escalate_conversation(
  p_conversation_id uuid,
  p_clinic_id       uuid,
  p_reason          text
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

  -- Fix #1: lock row. Idempotency check below depends on a stable read;
  -- without lock, two workers could both pass it and double-insert message
  -- + audit_logs even though only one UPDATE wins.
  -- The PERFORM transition_conversation_state below re-locks the same row
  -- inside the same transaction (PostgreSQL row locks are re-entrant
  -- within a transaction), so it's a noop on the second lock attempt.
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

  -- Idempotency: já escalada → no-op.
  IF v_old_state = 'waiting_human' THEN
    RETURN false;
  END IF;

  -- Delega pra 4-arg: valida transição, atualiza state + escalated_via='ai',
  -- insere audit_logs.action='conversation.state_changed'. Re-locks same row
  -- (re-entrant lock — noop). Tenant guard inside transition bypassed because
  -- escalate_conversation is service_role-only (auth.uid() = NULL).
  PERFORM public.transition_conversation_state(
    p_conversation_id, 'waiting_human', p_reason, 'ai'
  );

  v_msg_content := '🤖 IA escalou pra humano: ' || p_reason;

  INSERT INTO public.messages
    (clinic_id, conversation_id, direction, sender_type, content_type,
     content, delivery_status, outbox_status)
  VALUES
    (v_clinic_id, p_conversation_id, 'outbound', 'system', 'system',
     v_msg_content, 'sent', NULL);

  INSERT INTO public.audit_logs
    (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    (SELECT auth.uid()),
    'agent.tool.escalate',
    'conversations',
    p_conversation_id,
    jsonb_build_object(
      'reason', p_reason,
      'tool',   'escalate_to_human',
      'source', 'ai'
    )
  );

  RETURN true;
END;
$$;

-- Grants/REVOKEs preserved from 0018 (CREATE OR REPLACE doesn't reset them).

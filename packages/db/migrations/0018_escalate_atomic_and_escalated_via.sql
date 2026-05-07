-- ════════════════════════════════════════════════════════════════════════════
-- 0018_escalate_atomic_and_escalated_via.sql
--
-- PR-A: closes #11 (atomic escalate) + #13 (escalated_via flag).
-- Combines column + RPC overloads into one migration to avoid the venomous
-- intermediate state where escalate_conversation references a column that
-- does not yet exist.
--
-- transition_conversation_state strategy:
--   - 3-arg overload PERMANECE (CREATE OR REPLACE) — backward compat com 3
--     callers em packages/db/tests/rls/chat.test.ts que testam state machine.
--     Atualizada pra também limpar escalated_via=NULL ao voltar pra
--     'ai_handling', garantindo consistência se alguém chamar 3-arg pra
--     religar IA.
--   - 4-arg overload NOVA — última posição (escalated_via_value) sem DEFAULT
--     pra evitar ambiguidade de overload. Postgres resolve 2-3 args → 3-arg,
--     4 args → 4-arg, por arity exato.
--
-- escalate_conversation strategy:
--   - DELEGA validação de transição + UPDATE state + escalated_via='ai' +
--     audit conversation.state_changed pra transition_conversation_state(4-arg).
--     PERFORM dentro do BEGIN/END garante rollback completo em transição
--     inválida (RAISE EXCEPTION propaga).
--   - Adiciona INSERT system message + INSERT audit_logs(agent.tool.escalate)
--     paralelos. 2 audit rows preserva pattern atual de escalate.ts.
--
-- Security: SECURITY DEFINER + search_path = public, pg_catalog, pg_temp.
-- escalate_conversation: service_role-only (mirrors 0015/0017). 4-arg
-- transition_conversation_state: authenticated (UI server action).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Column: conversations.escalated_via ─────────────────────────────────────

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS escalated_via TEXT;

ALTER TABLE public.conversations
  DROP CONSTRAINT IF EXISTS conversations_escalated_via_valid;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_escalated_via_valid
  CHECK (escalated_via IS NULL OR escalated_via IN ('ai', 'manual'));

-- Backfill conservador: existing waiting_human → 'manual' (assume human-driven
-- até prova em contrário). Não fazemos heurística sobre system messages porque
-- (a) sender_type='system' inclui CHAT-1 onboarding rows também, (b) preferimos
-- começar a métrica limpa do que adivinhar histórico.
UPDATE public.conversations
SET escalated_via = 'manual'
WHERE state = 'waiting_human' AND escalated_via IS NULL;

-- ─── 3-arg transition_conversation_state (atualizada — clears escalated_via) ─

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
  SELECT state, clinic_id INTO v_old_state, v_clinic_id
  FROM public.conversations
  WHERE id = conv_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
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
         escalated_via = CASE WHEN new_state = 'ai_handling' THEN NULL ELSE escalated_via END,
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

-- ─── 4-arg transition_conversation_state (NOVA overload) ─────────────────────
-- Sem DEFAULT no 3º e 4º arg pra evitar ambiguidade com 3-arg overload.
-- Postgres resolve por arity exato: 4 args → essa; 2-3 args → 3-arg.

CREATE OR REPLACE FUNCTION public.transition_conversation_state(
  conv_id              uuid,
  new_state            text,
  reason               text,
  escalated_via_value  text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp AS $$
DECLARE
  v_old_state text;
  v_clinic_id uuid;
  v_allowed   text[];
BEGIN
  IF escalated_via_value IS NOT NULL
     AND escalated_via_value NOT IN ('ai', 'manual') THEN
    RAISE EXCEPTION 'escalated_via_value must be NULL, ''ai'' or ''manual''';
  END IF;

  SELECT state, clinic_id INTO v_old_state, v_clinic_id
  FROM public.conversations
  WHERE id = conv_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
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
           WHEN new_state = 'waiting_human' AND escalated_via_value IS NOT NULL
             THEN escalated_via_value
           WHEN new_state = 'ai_handling'
             THEN NULL
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
      'after',  jsonb_build_object('state', new_state, 'escalated_via', escalated_via_value),
      'reason', reason
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.transition_conversation_state(uuid, text, text, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.transition_conversation_state(uuid, text, text, text) FROM PUBLIC, anon;

-- ─── escalate_conversation (atomic, delega pra 4-arg transition) ─────────────

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

  SELECT state, clinic_id INTO v_old_state, v_clinic_id
  FROM public.conversations
  WHERE id = p_conversation_id AND deleted_at IS NULL;

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
  -- insere audit_logs.action='conversation.state_changed'. Se transição
  -- inválida, RAISE propaga e roll back tudo (BEGIN/END dessa função).
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

  -- Audit complementar específica do tool (paralelo ao state_changed acima).
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

REVOKE EXECUTE ON FUNCTION public.escalate_conversation(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.escalate_conversation(uuid, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.escalate_conversation(uuid, uuid, text) TO service_role;

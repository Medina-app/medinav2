-- ─── transition_conversation_state ───────────────────────────────────────────
-- SECURITY DEFINER so it can run as function owner and bypass message RLS when
-- reading the current state. Explicit search_path prevents injection.

CREATE OR REPLACE FUNCTION public.transition_conversation_state(
  conv_id   uuid,
  new_state text,
  reason    text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_old_state text;
  v_clinic_id uuid;
  v_allowed   text[];
BEGIN
  SELECT state, clinic_id
  INTO   v_old_state, v_clinic_id
  FROM   public.conversations
  WHERE  id = conv_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found or deleted';
  END IF;

  v_allowed := CASE v_old_state
    WHEN 'ai_handling'               THEN ARRAY['awaiting_template_response','waiting_human','paused','resolved']
    WHEN 'awaiting_template_response' THEN ARRAY['ai_handling','waiting_human','resolved']
    WHEN 'waiting_human'             THEN ARRAY['assigned','ai_handling','paused','resolved']
    WHEN 'assigned'                  THEN ARRAY['ai_handling','waiting_human','paused','resolved']
    WHEN 'paused'                    THEN ARRAY['ai_handling','waiting_human','resolved']
    WHEN 'resolved'                  THEN ARRAY[]::text[]
    ELSE                                  ARRAY[]::text[]
  END;

  IF NOT (new_state = ANY(v_allowed)) THEN
    RAISE EXCEPTION 'Invalid state transition from % to %', v_old_state, new_state;
  END IF;

  UPDATE public.conversations
  SET    state = new_state, updated_at = NOW()
  WHERE  id = conv_id;

  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    auth.uid(),
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

-- ─── Table: conversations ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.conversations (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id            uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  patient_id           uuid        REFERENCES public.patients(id) ON DELETE SET NULL,
  integration_id       uuid        NOT NULL REFERENCES public.clinic_integrations(id) ON DELETE RESTRICT,
  channel              text        NOT NULL CHECK (channel IN ('whatsapp','webchat','instagram','sms')),
  external_id          text        NOT NULL,
  state                text        NOT NULL DEFAULT 'ai_handling'
                                   CHECK (state IN ('ai_handling','awaiting_template_response','waiting_human','assigned','paused','resolved')),
  assigned_user_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  ai_enabled           boolean     NOT NULL DEFAULT true,
  last_message_at      timestamptz,
  last_message_preview text,
  last_inbound_at      timestamptz,
  last_outbound_at     timestamptz,
  unread_count         int         NOT NULL DEFAULT 0,
  tags                 text[]      NOT NULL DEFAULT '{}',
  metadata             jsonb       NOT NULL DEFAULT '{}',
  pinned               boolean     NOT NULL DEFAULT false,
  archived_at          timestamptz,
  resolved_at          timestamptz,
  resolved_by          uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT NOW(),
  updated_at           timestamptz NOT NULL DEFAULT NOW()
);

-- Inbox index (most used: active conversations ordered by recency)
CREATE INDEX IF NOT EXISTS idx_conversations_clinic_state_last_msg
  ON public.conversations (clinic_id, state, last_message_at DESC)
  WHERE deleted_at IS NULL;

-- Assigned-to-me view
CREATE INDEX IF NOT EXISTS idx_conversations_clinic_assigned_last_msg
  ON public.conversations (clinic_id, assigned_user_id, last_message_at DESC)
  WHERE deleted_at IS NULL;

-- Prevent duplicate open conversation per contact+integration
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_clinic_integration_external_unique
  ON public.conversations (clinic_id, integration_id, external_id)
  WHERE deleted_at IS NULL;

-- Patient conversation history
CREATE INDEX IF NOT EXISTS idx_conversations_clinic_patient
  ON public.conversations (clinic_id, patient_id)
  WHERE deleted_at IS NULL;

-- Archived conversations list
CREATE INDEX IF NOT EXISTS idx_conversations_clinic_archived
  ON public.conversations (clinic_id, archived_at)
  WHERE archived_at IS NOT NULL;

-- Main inbox (ai_handling + waiting_human + assigned, non-deleted)
CREATE INDEX IF NOT EXISTS idx_conversations_clinic_inbox
  ON public.conversations (clinic_id, last_message_at DESC)
  WHERE state IN ('ai_handling','waiting_human','assigned') AND deleted_at IS NULL;

-- ─── Table: messages ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.messages (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    uuid        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  clinic_id          uuid        NOT NULL,
  direction          text        NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_type        text        NOT NULL CHECK (sender_type IN ('patient','ai','human','system')),
  sender_user_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  content_type       text        NOT NULL CHECK (content_type IN ('text','image','audio','video','document','template','system')),
  content            text,
  media_url          text,
  media_metadata     jsonb,
  template_name      text,
  template_variables jsonb,
  external_id        text,
  delivery_status    text        NOT NULL DEFAULT 'pending'
                                 CHECK (delivery_status IN ('pending','sent','delivered','read','failed')),
  delivery_error     text,
  outbox_status      text        CHECK (outbox_status IS NULL OR outbox_status IN ('pending','processing','sent','failed')),
  ai_metadata        jsonb,
  agent_config_id    uuid,
  in_reply_to        uuid        REFERENCES public.messages(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT NOW()
);

-- Message thread listing
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
  ON public.messages (conversation_id, created_at);

-- Webhook deduplication (inbound external_id)
CREATE INDEX IF NOT EXISTS idx_messages_clinic_external_id
  ON public.messages (clinic_id, external_id)
  WHERE external_id IS NOT NULL;

-- Outbox worker queue
CREATE INDEX IF NOT EXISTS idx_messages_outbox_worker
  ON public.messages (outbox_status, created_at)
  WHERE outbox_status IN ('pending','failed');

-- Delivery failure monitoring
CREATE INDEX IF NOT EXISTS idx_messages_delivery_status
  ON public.messages (delivery_status)
  WHERE delivery_status IN ('pending','failed');

-- ─── Trigger: conversations set_updated_at ────────────────────────────────────

CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Trigger: validate patient belongs to same clinic ─────────────────────────
-- Runs as table owner (SECURITY DEFINER) to bypass patient RLS on the lookup.

CREATE OR REPLACE FUNCTION public.validate_conversation_patient_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF NEW.patient_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.patients
      WHERE id = NEW.patient_id AND clinic_id = NEW.clinic_id
    ) THEN
      RAISE EXCEPTION 'patient_id does not belong to the same clinic as this conversation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_conversations_validate_patient_clinic
  BEFORE INSERT OR UPDATE OF patient_id, clinic_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.validate_conversation_patient_clinic();

-- ─── Trigger: audit assigned_user_id and ai_enabled changes ──────────────────
-- State changes are logged by transition_conversation_state (not here) to avoid
-- double-logging.

CREATE OR REPLACE FUNCTION public.audit_conversation_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    NEW.clinic_id,
    auth.uid(),
    'conversation.updated',
    'conversations',
    NEW.id,
    jsonb_build_object(
      'before', jsonb_build_object(
        'assigned_user_id', OLD.assigned_user_id,
        'ai_enabled',       OLD.ai_enabled
      ),
      'after', jsonb_build_object(
        'assigned_user_id', NEW.assigned_user_id,
        'ai_enabled',       NEW.ai_enabled
      )
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_conversations_audit_change
  AFTER UPDATE ON public.conversations
  FOR EACH ROW
  WHEN (OLD.assigned_user_id IS DISTINCT FROM NEW.assigned_user_id
     OR OLD.ai_enabled IS DISTINCT FROM NEW.ai_enabled)
  EXECUTE FUNCTION public.audit_conversation_change();

-- ─── Trigger: validate message clinic_id matches conversation clinic_id ────────

CREATE OR REPLACE FUNCTION public.validate_message_clinic_match()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_conv_clinic_id uuid;
BEGIN
  SELECT clinic_id INTO v_conv_clinic_id
  FROM   public.conversations
  WHERE  id = NEW.conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation not found';
  END IF;

  IF v_conv_clinic_id <> NEW.clinic_id THEN
    RAISE EXCEPTION 'message clinic_id does not match conversation clinic_id';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_messages_validate_clinic_match
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.validate_message_clinic_match();

-- ─── Trigger: update conversation denormalized fields on new message ──────────

CREATE OR REPLACE FUNCTION public.update_conversation_on_message()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  UPDATE public.conversations
  SET
    last_message_at      = NEW.created_at,
    last_message_preview = left(NEW.content, 100),
    last_inbound_at      = CASE WHEN NEW.direction = 'inbound'  THEN NEW.created_at ELSE last_inbound_at  END,
    last_outbound_at     = CASE WHEN NEW.direction = 'outbound' THEN NEW.created_at ELSE last_outbound_at END,
    unread_count         = CASE WHEN NEW.direction = 'inbound'  THEN unread_count + 1 ELSE 0 END,
    updated_at           = NOW()
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_messages_update_conversation
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.update_conversation_on_message();

-- ─── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations FORCE ROW LEVEL SECURITY;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages FORCE ROW LEVEL SECURITY;

-- conversations: SELECT filters soft-deleted rows
CREATE POLICY "conversations: members can select"
  ON public.conversations FOR SELECT
  USING (is_clinic_member(clinic_id) AND deleted_at IS NULL);

CREATE POLICY "conversations: members can insert"
  ON public.conversations FOR INSERT
  WITH CHECK (is_clinic_member(clinic_id));

-- UPDATE: assigned agent OR admin/owner can update
-- (select auth.uid()) evaluated once per statement, not per row
CREATE POLICY "conversations: assigned or admin can update"
  ON public.conversations FOR UPDATE
  USING  (assigned_user_id = (select auth.uid())
          OR has_clinic_role(clinic_id, 'admin')
          OR has_clinic_role(clinic_id, 'owner'))
  WITH CHECK (assigned_user_id = (select auth.uid())
          OR has_clinic_role(clinic_id, 'admin')
          OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "conversations: admins can delete"
  ON public.conversations FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

-- messages: members can read and insert; no UPDATE/DELETE for authenticated role
CREATE POLICY "messages: members can select"
  ON public.messages FOR SELECT
  USING (is_clinic_member(clinic_id));

CREATE POLICY "messages: members can insert"
  ON public.messages FOR INSERT
  WITH CHECK (is_clinic_member(clinic_id));

-- ─── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT SELECT, INSERT ON public.messages TO authenticated;
-- Explicit REVOKE to ensure no UPDATE/DELETE leaks to authenticated
REVOKE UPDATE, DELETE ON public.messages FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_conversation_state(uuid, text, text) TO authenticated;

-- Trigger functions must not be callable via REST or PostgREST
REVOKE EXECUTE ON FUNCTION public.transition_conversation_state(uuid, text, text)   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.validate_conversation_patient_clinic()             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_conversation_change()                        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_message_clinic_match()                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_conversation_on_message()                   FROM PUBLIC, anon, authenticated;

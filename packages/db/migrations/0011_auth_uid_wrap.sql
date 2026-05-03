-- ─── Wrap bare auth.uid() in (SELECT auth.uid()) for consistency ──────────────
-- Migrations 0007-0009 use the wrapped form. This backfills 0002, 0004, 0005.
-- The wrap forces a subquery plan, preventing per-row re-evaluation in contexts
-- where the planner might otherwise inline the call. Required by codebase convention.

-- 0002: audit_integration_change
CREATE OR REPLACE FUNCTION public.audit_integration_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_action      text;
  v_after_data  jsonb;
  v_before_data jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action      := 'integration.created';
    v_after_data  := (to_jsonb(NEW) - 'encrypted_credentials');
    v_before_data := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
      v_action := 'integration.deleted';
    ELSIF NEW.status = 'active' AND OLD.status != 'active' THEN
      v_action := 'integration.activated';
    ELSIF NEW.status = 'error'  AND OLD.status != 'error'  THEN
      v_action := 'integration.errored';
    ELSE
      v_action := 'integration.updated';
    END IF;
    v_after_data  := (to_jsonb(NEW) - 'encrypted_credentials');
    v_before_data := (to_jsonb(OLD) - 'encrypted_credentials');
  END IF;

  INSERT INTO public.audit_logs (
    clinic_id, user_id, action, resource, resource_id, metadata
  ) VALUES (
    NEW.clinic_id,
    (SELECT auth.uid()),
    v_action,
    'clinic_integrations',
    NEW.id,
    jsonb_build_object('before', v_before_data, 'after', v_after_data)
  );

  RETURN NEW;
END;
$$;

-- 0004: audit_patient_change
CREATE OR REPLACE FUNCTION public.audit_patient_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_action      text;
  v_after_data  jsonb;
  v_before_data jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action      := 'patient.created';
    v_after_data  := (to_jsonb(NEW) - 'encrypted_cpf' - 'cpf_hash');
    v_before_data := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
      v_action := 'patient.deleted';
    ELSE
      v_action := 'patient.updated';
    END IF;
    v_after_data  := (to_jsonb(NEW) - 'encrypted_cpf' - 'cpf_hash');
    v_before_data := (to_jsonb(OLD) - 'encrypted_cpf' - 'cpf_hash');
  END IF;

  INSERT INTO public.audit_logs (
    clinic_id, user_id, action, resource, resource_id, metadata
  ) VALUES (
    NEW.clinic_id,
    (SELECT auth.uid()),
    v_action,
    'patients',
    NEW.id,
    jsonb_build_object('before', v_before_data, 'after', v_after_data)
  );

  RETURN NEW;
END;
$$;

-- 0004: get_patient_cpf
CREATE OR REPLACE FUNCTION public.get_patient_cpf(p_patient_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER
SET search_path = extensions, public, pg_catalog AS $$
DECLARE
  v_clinic_id UUID;
  v_encrypted BYTEA;
  v_key       TEXT;
BEGIN
  SELECT clinic_id, encrypted_cpf
  INTO   v_clinic_id, v_encrypted
  FROM   public.patients
  WHERE  id = p_patient_id
    AND  deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient not found';
  END IF;

  IF NOT has_clinic_role(v_clinic_id, 'admin')
     AND NOT has_clinic_role(v_clinic_id, 'owner')
  THEN
    RAISE EXCEPTION 'access denied: requires admin or owner role';
  END IF;

  IF v_encrypted IS NULL THEN
    RETURN NULL;
  END IF;

  v_key := current_setting('app.encryption_key', TRUE);
  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'app.encryption_key is not configured for this session';
  END IF;

  INSERT INTO public.audit_logs (
    clinic_id, user_id, action, resource, resource_id, metadata
  ) VALUES (
    v_clinic_id,
    (SELECT auth.uid()),
    'patient.cpf_accessed',
    'patients',
    p_patient_id,
    '{}'::jsonb
  );

  RETURN pgp_sym_decrypt(v_encrypted, v_key);
END;
$$;

-- 0005: transition_conversation_state
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

-- 0005: audit_conversation_change
CREATE OR REPLACE FUNCTION public.audit_conversation_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    NEW.clinic_id,
    (SELECT auth.uid()),
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

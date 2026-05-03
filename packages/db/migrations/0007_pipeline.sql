-- ─── Table: pipelines ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pipelines (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description  text,
  color        text        NOT NULL DEFAULT '#06B6D4'
               CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  position     int         NOT NULL DEFAULT 0,
  is_default   boolean     NOT NULL DEFAULT false,
  archived_at  timestamptz,
  metadata     jsonb       NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  updated_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipelines_clinic_position
  ON public.pipelines (clinic_id, position)
  WHERE archived_at IS NULL;

-- Only 1 default pipeline per clinic (not archived).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_clinic_default_unique
  ON public.pipelines (clinic_id)
  WHERE is_default = true AND archived_at IS NULL;

-- ─── Table: pipeline_stages ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pipeline_stages (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         uuid        NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  pipeline_id       uuid        NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  name              text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description       text,
  position          int         NOT NULL DEFAULT 0,
  color             text,
  stage_type        text        NOT NULL DEFAULT 'open'
                    CHECK (stage_type IN ('open', 'won', 'lost')),
  automation_rules  jsonb       NOT NULL DEFAULT '{}',
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_clinic_pipeline_position
  ON public.pipeline_stages (clinic_id, pipeline_id, position)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_clinic_pipeline_type
  ON public.pipeline_stages (clinic_id, pipeline_id, stage_type);

-- ─── Table: deals ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.deals (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id            uuid          NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  pipeline_id          uuid          NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  stage_id             uuid          NOT NULL REFERENCES public.pipeline_stages(id) ON DELETE RESTRICT,
  patient_id           uuid          REFERENCES public.patients(id) ON DELETE SET NULL,
  conversation_id      uuid          REFERENCES public.conversations(id) ON DELETE SET NULL,
  title                text          NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description          text,
  value                numeric(12,2),
  expected_close_date  date,
  position             int           NOT NULL DEFAULT 0,
  assigned_user_id     uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  priority             text          NOT NULL DEFAULT 'normal'
                       CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  tags                 text[]        NOT NULL DEFAULT '{}',
  source               text          CHECK (source IN ('whatsapp', 'manual', 'imported', 'website')),
  last_activity_at     timestamptz,
  won_at               timestamptz,
  lost_at              timestamptz,
  lost_reason          text,
  metadata             jsonb         NOT NULL DEFAULT '{}',
  created_by           uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  archived_at          timestamptz,
  created_at           timestamptz   NOT NULL DEFAULT NOW(),
  updated_at           timestamptz   NOT NULL DEFAULT NOW()
);

-- Primary kanban query: all active deals for a pipeline ordered by position
CREATE INDEX IF NOT EXISTS idx_deals_clinic_pipeline_stage_position
  ON public.deals (clinic_id, pipeline_id, stage_id, position)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deals_clinic_assigned
  ON public.deals (clinic_id, assigned_user_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deals_clinic_patient
  ON public.deals (clinic_id, patient_id)
  WHERE archived_at IS NULL AND patient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deals_clinic_conversation
  ON public.deals (clinic_id, conversation_id)
  WHERE archived_at IS NULL AND conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deals_tags
  ON public.deals USING GIN (tags);

-- ─── Trigger: set_updated_at on all three tables ──────────────────────────────

CREATE TRIGGER trg_pipelines_updated_at
  BEFORE UPDATE ON public.pipelines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_pipeline_stages_updated_at
  BEFORE UPDATE ON public.pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_deals_updated_at
  BEFORE UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Trigger: validate stage belongs to same clinic as pipeline ───────────────
-- SECURITY DEFINER to bypass RLS when doing the cross-table check.

CREATE OR REPLACE FUNCTION public.validate_stage_clinic_match()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_pipeline_clinic_id uuid;
BEGIN
  SELECT clinic_id INTO v_pipeline_clinic_id
  FROM   public.pipelines
  WHERE  id = NEW.pipeline_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pipeline not found';
  END IF;

  IF v_pipeline_clinic_id <> NEW.clinic_id THEN
    RAISE EXCEPTION 'pipeline_stage clinic_id does not match pipeline clinic_id';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pipeline_stages_validate_clinic
  BEFORE INSERT OR UPDATE OF clinic_id, pipeline_id ON public.pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION public.validate_stage_clinic_match();

-- ─── Trigger: validate deal clinic matches stage and pipeline ─────────────────

CREATE OR REPLACE FUNCTION public.validate_deal_clinic_match()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_stage_clinic_id uuid;
BEGIN
  SELECT clinic_id INTO v_stage_clinic_id
  FROM   public.pipeline_stages
  WHERE  id = NEW.stage_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pipeline_stage not found';
  END IF;

  IF v_stage_clinic_id <> NEW.clinic_id THEN
    RAISE EXCEPTION 'deal clinic_id does not match stage clinic_id';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deals_validate_stage_clinic
  BEFORE INSERT OR UPDATE OF clinic_id, stage_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.validate_deal_clinic_match();

-- ─── Trigger: validate deal.patient_id belongs to same clinic ────────────────

CREATE OR REPLACE FUNCTION public.validate_deal_patient_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.patient_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.patients
      WHERE id = NEW.patient_id AND clinic_id = NEW.clinic_id
    ) THEN
      RAISE EXCEPTION 'deal patient_id does not belong to the same clinic';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deals_validate_patient_clinic
  BEFORE INSERT OR UPDATE OF patient_id, clinic_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.validate_deal_patient_clinic();

-- ─── Trigger: validate deal.conversation_id belongs to same clinic ───────────

CREATE OR REPLACE FUNCTION public.validate_deal_conversation_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.conversation_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.conversations
      WHERE id = NEW.conversation_id AND clinic_id = NEW.clinic_id
    ) THEN
      RAISE EXCEPTION 'deal conversation_id does not belong to the same clinic';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deals_validate_conversation_clinic
  BEFORE INSERT OR UPDATE OF conversation_id, clinic_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.validate_deal_conversation_clinic();

-- ─── Trigger: audit stage change + set won_at / lost_at ──────────────────────

CREATE OR REPLACE FUNCTION public.audit_deal_stage_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_stage_type text;
BEGIN
  -- Audit log
  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    NEW.clinic_id,
    (select auth.uid()),
    'deal.stage_changed',
    'deals',
    NEW.id,
    jsonb_build_object(
      'before', jsonb_build_object('stage_id', OLD.stage_id),
      'after',  jsonb_build_object('stage_id', NEW.stage_id)
    )
  );

  -- Update last_activity_at
  NEW.last_activity_at := NOW();

  -- Set won_at / lost_at based on the destination stage type
  SELECT stage_type INTO v_stage_type
  FROM   public.pipeline_stages
  WHERE  id = NEW.stage_id;

  IF v_stage_type = 'won' THEN
    NEW.won_at  := NOW();
    NEW.lost_at := NULL;
  ELSIF v_stage_type = 'lost' THEN
    NEW.lost_at := NOW();
    NEW.won_at  := NULL;
  ELSE
    NEW.won_at  := NULL;
    NEW.lost_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_deals_audit_stage_change
  BEFORE UPDATE OF stage_id ON public.deals
  FOR EACH ROW
  WHEN (OLD.stage_id IS DISTINCT FROM NEW.stage_id)
  EXECUTE FUNCTION public.audit_deal_stage_change();

-- ─── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.pipelines       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipelines       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_stages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.deals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deals           FORCE ROW LEVEL SECURITY;

-- pipelines: members read, admins write
CREATE POLICY "pipelines: members can select"
  ON public.pipelines FOR SELECT
  USING (is_clinic_member(clinic_id));

CREATE POLICY "pipelines: admins can insert"
  ON public.pipelines FOR INSERT
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "pipelines: admins can update"
  ON public.pipelines FOR UPDATE
  USING  (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'))
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "pipelines: admins can delete"
  ON public.pipelines FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

-- pipeline_stages: members read, admins write
CREATE POLICY "pipeline_stages: members can select"
  ON public.pipeline_stages FOR SELECT
  USING (is_clinic_member(clinic_id));

CREATE POLICY "pipeline_stages: admins can insert"
  ON public.pipeline_stages FOR INSERT
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "pipeline_stages: admins can update"
  ON public.pipeline_stages FOR UPDATE
  USING  (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'))
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "pipeline_stages: admins can delete"
  ON public.pipeline_stages FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

-- deals: members read all, members insert, assigned_user or admin update, admin delete
CREATE POLICY "deals: members can select"
  ON public.deals FOR SELECT
  USING (is_clinic_member(clinic_id));

CREATE POLICY "deals: members can insert"
  ON public.deals FOR INSERT
  WITH CHECK (is_clinic_member(clinic_id));

CREATE POLICY "deals: assigned or admin can update"
  ON public.deals FOR UPDATE
  USING  (assigned_user_id = (select auth.uid())
          OR has_clinic_role(clinic_id, 'admin')
          OR has_clinic_role(clinic_id, 'owner'))
  WITH CHECK (assigned_user_id = (select auth.uid())
          OR has_clinic_role(clinic_id, 'admin')
          OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "deals: admins can delete"
  ON public.deals FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

-- ─── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipelines       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipeline_stages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deals           TO authenticated;

REVOKE EXECUTE ON FUNCTION public.validate_stage_clinic_match()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_deal_clinic_match()         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_deal_patient_clinic()       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_deal_conversation_clinic()  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_deal_stage_change()            FROM PUBLIC, anon, authenticated;

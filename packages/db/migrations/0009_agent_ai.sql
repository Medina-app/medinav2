-- ─── Table: public.agent_configs ─────────────────────────────────────────────
-- Immutable-versioned AI agent configurations.
-- Lifecycle: draft → published (only one per clinic+name) → archived.
-- Version is auto-set by trigger; never mutate a published config — create a new version.

CREATE TABLE IF NOT EXISTS public.agent_configs (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id              uuid          NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name                   text          NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  version                int           NOT NULL DEFAULT 0,
  status                 text          NOT NULL DEFAULT 'draft'
                                       CHECK (status IN ('draft', 'published', 'archived')),
  system_prompt          text          NOT NULL,
  model                  text          NOT NULL,
  temperature            numeric(3,2)  NOT NULL DEFAULT 0.7
                                       CHECK (temperature >= 0 AND temperature <= 2),
  max_tokens             int           NOT NULL DEFAULT 1024
                                       CHECK (max_tokens > 0),
  tools                  jsonb         NOT NULL DEFAULT '[]',
  guardrails             jsonb         NOT NULL DEFAULT '{}',
  handoff_rules          jsonb         NOT NULL DEFAULT '{}',
  knowledge_document_ids uuid[]        NOT NULL DEFAULT '{}',
  metadata               jsonb         NOT NULL DEFAULT '{}',
  published_at           timestamptz,
  published_by           uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  archived_at            timestamptz,
  created_by             uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at             timestamptz   NOT NULL DEFAULT NOW(),
  updated_at             timestamptz   NOT NULL DEFAULT NOW()
);

-- Unique version per (clinic, name) for non-archived records
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_configs_clinic_name_version
  ON public.agent_configs (clinic_id, name, version)
  WHERE archived_at IS NULL;

-- At most one published per (clinic, name)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_configs_clinic_name_published_unique
  ON public.agent_configs (clinic_id, name)
  WHERE status = 'published' AND archived_at IS NULL;

-- Browsing by status
CREATE INDEX IF NOT EXISTS idx_agent_configs_clinic_status_created
  ON public.agent_configs (clinic_id, status, created_at DESC);

-- ─── Table: public.knowledge_documents ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.knowledge_documents (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        uuid          NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  title            text          NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description      text,
  source_type      text          NOT NULL
                                 CHECK (source_type IN ('pdf','docx','txt','md','url','manual')),
  source_url       text,
  file_size_bytes  bigint,
  file_mime_type   text,
  content_hash     text,
  status           text          NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','processing','indexed','failed','archived')),
  error_message    text,
  chunk_count      int           NOT NULL DEFAULT 0,
  total_tokens     int           NOT NULL DEFAULT 0,
  embedding_model  text,
  tags             text[]        NOT NULL DEFAULT '{}',
  metadata         jsonb         NOT NULL DEFAULT '{}',
  indexed_at       timestamptz,
  archived_at      timestamptz,
  created_by       uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz   NOT NULL DEFAULT NOW(),
  updated_at       timestamptz   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_clinic_status
  ON public.knowledge_documents (clinic_id, status)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_clinic_source_type
  ON public.knowledge_documents (clinic_id, source_type)
  WHERE archived_at IS NULL;

-- Content deduplication
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_clinic_content_hash
  ON public.knowledge_documents (clinic_id, content_hash)
  WHERE content_hash IS NOT NULL;

-- Full-text tag filter
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_tags
  ON public.knowledge_documents USING GIN (tags);

-- Fuzzy title search
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_title_trgm
  ON public.knowledge_documents USING GIN (title gin_trgm_ops)
  WHERE archived_at IS NULL;

-- ─── Table: public.knowledge_chunks ──────────────────────────────────────────
-- clinic_id is denormalized here for RLS performance (avoids JOIN to knowledge_documents).

CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    uuid          NOT NULL,
  document_id  uuid          NOT NULL REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
  chunk_index  int           NOT NULL,
  content      text          NOT NULL,
  token_count  int           NOT NULL,
  embedding    vector(1536)  NOT NULL,
  metadata     jsonb         NOT NULL DEFAULT '{}',
  created_at   timestamptz   NOT NULL DEFAULT NOW()
);

-- Unique chunk position per document
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_chunks_doc_chunk_unique
  ON public.knowledge_chunks (clinic_id, document_id, chunk_index);

-- Document listing
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document_chunk
  ON public.knowledge_chunks (document_id, chunk_index);

-- HNSW vector similarity index for fast cosine search
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw
  ON public.knowledge_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ─── FK: messages.agent_config_id → agent_configs ────────────────────────────
-- The column exists since Issue 9; now we add the FK constraint.

ALTER TABLE public.messages
  ADD CONSTRAINT messages_agent_config_id_fk
  FOREIGN KEY (agent_config_id)
  REFERENCES public.agent_configs(id)
  ON DELETE SET NULL;

-- ─── Trigger function: auto_set_agent_version ─────────────────────────────────
-- BEFORE INSERT: auto-computes version = max(version) + 1 for (clinic, name).
-- DEFAULT 0 on the column is a sentinel the trigger always replaces.
-- SECURITY DEFINER: queries agent_configs which has RLS enabled.

CREATE OR REPLACE FUNCTION public.auto_set_agent_version()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  SELECT COALESCE(MAX(version), 0) + 1
  INTO   NEW.version
  FROM   public.agent_configs
  WHERE  clinic_id = NEW.clinic_id
    AND  name      = NEW.name;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_agent_configs_auto_version
  BEFORE INSERT ON public.agent_configs
  FOR EACH ROW EXECUTE FUNCTION public.auto_set_agent_version();

-- ─── Trigger function: set_updated_at on agent_configs ────────────────────────

CREATE TRIGGER trg_agent_configs_updated_at
  BEFORE UPDATE ON public.agent_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Trigger function: set_updated_at on knowledge_documents ─────────────────

CREATE TRIGGER trg_knowledge_documents_updated_at
  BEFORE UPDATE ON public.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Trigger function: validate_chunk_clinic_match ────────────────────────────
-- BEFORE INSERT on knowledge_chunks: clinic_id must match document's clinic_id.
-- SECURITY DEFINER: queries knowledge_documents which has RLS enabled.

CREATE OR REPLACE FUNCTION public.validate_chunk_clinic_match()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_doc_clinic_id uuid;
BEGIN
  SELECT clinic_id INTO v_doc_clinic_id
  FROM   public.knowledge_documents
  WHERE  id = NEW.document_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge_document not found: %', NEW.document_id;
  END IF;

  IF v_doc_clinic_id <> NEW.clinic_id THEN
    RAISE EXCEPTION 'knowledge_chunk clinic_id does not match document clinic_id';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_knowledge_chunks_validate_clinic
  BEFORE INSERT ON public.knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION public.validate_chunk_clinic_match();

-- ─── Trigger function: validate_message_agent_config_clinic ──────────────────
-- BEFORE INSERT on messages: agent_config_id must belong to the same clinic
-- and must be in 'published' status (drafts cannot be referenced).
-- SECURITY DEFINER: queries agent_configs which has RLS enabled.

CREATE OR REPLACE FUNCTION public.validate_message_agent_config_clinic()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_agent_clinic_id uuid;
  v_agent_status    text;
BEGIN
  IF NEW.agent_config_id IS NOT NULL THEN
    SELECT clinic_id, status
    INTO   v_agent_clinic_id, v_agent_status
    FROM   public.agent_configs
    WHERE  id = NEW.agent_config_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'agent_config not found: %', NEW.agent_config_id;
    END IF;

    IF v_agent_clinic_id <> NEW.clinic_id THEN
      RAISE EXCEPTION 'message agent_config_id does not belong to the same clinic';
    END IF;

    IF v_agent_status <> 'published' THEN
      RAISE EXCEPTION 'message can only reference a published agent_config, current status: %', v_agent_status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_messages_validate_agent_config_clinic
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.validate_message_agent_config_clinic();

-- ─── Trigger function: audit_agent_config_change ──────────────────────────────
-- AFTER INSERT OR UPDATE on agent_configs: writes to audit_logs.
-- auth.uid() returns NULL when triggered by service_role — audit_logs.user_id allows NULL.
-- SECURITY DEFINER: inserts into audit_logs.

CREATE OR REPLACE FUNCTION public.audit_agent_config_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    NEW.clinic_id,
    (SELECT auth.uid()),
    CASE TG_OP
      WHEN 'INSERT' THEN 'agent_config.created'
      ELSE               'agent_config.updated'
    END,
    'agent_configs',
    NEW.id,
    CASE TG_OP
      WHEN 'INSERT' THEN jsonb_build_object('name', NEW.name, 'version', NEW.version, 'status', NEW.status)
      ELSE jsonb_build_object(
        'before', jsonb_build_object('status', OLD.status),
        'after',  jsonb_build_object('status', NEW.status, 'name', NEW.name, 'version', NEW.version)
      )
    END
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_agent_configs_audit
  AFTER INSERT OR UPDATE ON public.agent_configs
  FOR EACH ROW EXECUTE FUNCTION public.audit_agent_config_change();

-- ─── Trigger function: audit_knowledge_document_change ───────────────────────
-- AFTER INSERT OR UPDATE on knowledge_documents: writes to audit_logs.

CREATE OR REPLACE FUNCTION public.audit_knowledge_document_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    NEW.clinic_id,
    (SELECT auth.uid()),
    CASE TG_OP
      WHEN 'INSERT' THEN 'knowledge_document.created'
      ELSE               'knowledge_document.updated'
    END,
    'knowledge_documents',
    NEW.id,
    jsonb_build_object('title', NEW.title, 'status', NEW.status, 'source_type', NEW.source_type)
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_knowledge_documents_audit
  AFTER INSERT OR UPDATE ON public.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.audit_knowledge_document_change();

-- ─── RLS: agent_configs ───────────────────────────────────────────────────────

ALTER TABLE public.agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_configs FORCE ROW LEVEL SECURITY;

-- Members read non-archived configs
CREATE POLICY "agent_configs: members can select"
  ON public.agent_configs FOR SELECT
  USING (is_clinic_member(clinic_id) AND archived_at IS NULL);

CREATE POLICY "agent_configs: admins can insert"
  ON public.agent_configs FOR INSERT
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "agent_configs: admins can update"
  ON public.agent_configs FOR UPDATE
  USING  (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'))
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "agent_configs: admins can delete"
  ON public.agent_configs FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

-- ─── RLS: knowledge_documents ────────────────────────────────────────────────

ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY "knowledge_documents: members can select"
  ON public.knowledge_documents FOR SELECT
  USING (is_clinic_member(clinic_id) AND archived_at IS NULL);

CREATE POLICY "knowledge_documents: admins can insert"
  ON public.knowledge_documents FOR INSERT
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "knowledge_documents: admins can update"
  ON public.knowledge_documents FOR UPDATE
  USING  (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'))
  WITH CHECK (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

CREATE POLICY "knowledge_documents: admins can delete"
  ON public.knowledge_documents FOR DELETE
  USING (has_clinic_role(clinic_id, 'admin') OR has_clinic_role(clinic_id, 'owner'));

-- ─── RLS: knowledge_chunks ───────────────────────────────────────────────────
-- Write is service_role only (indexing worker bypasses RLS).
-- authenticated role gets SELECT only.

ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_chunks FORCE ROW LEVEL SECURITY;

CREATE POLICY "knowledge_chunks: members can select"
  ON public.knowledge_chunks FOR SELECT
  USING (is_clinic_member(clinic_id));

-- ─── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_configs      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.knowledge_documents TO authenticated;
GRANT SELECT                         ON public.knowledge_chunks    TO authenticated;

-- Trigger functions must not be callable directly via REST or PostgREST
REVOKE EXECUTE ON FUNCTION public.auto_set_agent_version()                  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_chunk_clinic_match()             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.validate_message_agent_config_clinic()    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_agent_config_change()               FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.audit_knowledge_document_change()         FROM PUBLIC, anon, authenticated;

-- ─── Helper: publish_agent_config ─────────────────────────────────────────────
-- SECURITY DEFINER: validates caller role, archives old published version,
-- marks new version as published, writes audit log — atomically.
-- Callable by authenticated role only (GRANT below).

CREATE OR REPLACE FUNCTION public.publish_agent_config(
  p_config_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  v_clinic_id uuid;
  v_name      text;
  v_status    text;
BEGIN
  SELECT clinic_id, name, status
  INTO   v_clinic_id, v_name, v_status
  FROM   public.agent_configs
  WHERE  id = p_config_id AND archived_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent_config not found or already archived: %', p_config_id;
  END IF;

  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'only draft configs can be published, current status: %', v_status;
  END IF;

  -- Caller must be admin or owner of the clinic
  IF NOT (has_clinic_role(v_clinic_id, 'admin') OR has_clinic_role(v_clinic_id, 'owner')) THEN
    RAISE EXCEPTION 'caller must be admin or owner of clinic % to publish agent config', v_clinic_id;
  END IF;

  -- Archive any currently published version for this (clinic, name)
  UPDATE public.agent_configs
  SET    status      = 'archived',
         archived_at = NOW(),
         updated_at  = NOW()
  WHERE  clinic_id   = v_clinic_id
    AND  name        = v_name
    AND  status      = 'published'
    AND  archived_at IS NULL;

  -- Mark this config as published
  UPDATE public.agent_configs
  SET    status       = 'published',
         published_at = NOW(),
         published_by = (SELECT auth.uid()),
         updated_at   = NOW()
  WHERE  id = p_config_id;

  -- Audit log for the publish action (the AFTER trigger will also fire, but this is the explicit publish event)
  INSERT INTO public.audit_logs (clinic_id, user_id, action, resource, resource_id, metadata)
  VALUES (
    v_clinic_id,
    (SELECT auth.uid()),
    'agent_config.published',
    'agent_configs',
    p_config_id,
    jsonb_build_object('name', v_name)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.publish_agent_config(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.publish_agent_config(uuid) FROM PUBLIC, anon;

-- ─── Helper: search_knowledge_chunks ──────────────────────────────────────────
-- STABLE SECURITY DEFINER: validates caller membership, performs vector similarity
-- search restricted to target_clinic_id.
-- Returns top_k chunks ordered by cosine similarity (closest first).

CREATE OR REPLACE FUNCTION public.search_knowledge_chunks(
  target_clinic_id uuid,
  query_embedding  vector(1536),
  top_k            int     DEFAULT 5,
  document_filter  uuid[]  DEFAULT NULL
) RETURNS TABLE (
  chunk_id    uuid,
  document_id uuid,
  content     text,
  similarity  float,
  metadata    jsonb
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
  IF NOT is_clinic_member(target_clinic_id) THEN
    RAISE EXCEPTION 'caller is not a member of clinic %', target_clinic_id;
  END IF;

  RETURN QUERY
  SELECT
    kc.id,
    kc.document_id,
    kc.content,
    (1 - (kc.embedding <=> query_embedding))::float AS similarity,
    kc.metadata
  FROM public.knowledge_chunks kc
  WHERE kc.clinic_id = target_clinic_id
    AND (document_filter IS NULL OR kc.document_id = ANY(document_filter))
  ORDER BY kc.embedding <=> query_embedding
  LIMIT top_k;
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_knowledge_chunks(uuid, vector, int, uuid[]) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.search_knowledge_chunks(uuid, vector, int, uuid[]) FROM PUBLIC, anon;

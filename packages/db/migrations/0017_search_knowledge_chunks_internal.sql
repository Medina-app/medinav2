-- ════════════════════════════════════════════════════════════════════════════
-- 0017_search_knowledge_chunks_internal.sql
--
-- Worker-only variant of search_knowledge_chunks without the is_clinic_member
-- check. Required because Inngest workers run with service_role JWT, which
-- makes auth.uid() return NULL — is_clinic_member(target_clinic_id) then
-- defaults p_user_id to NULL, the EXISTS lookup against clinic_members never
-- matches, and the original function (0009:451) RAISEs 'caller is not a
-- member of clinic %'. The AI-3 search_kb tool fails silently in production
-- because Mastra/AI-SDK swallows the throw and records output=undefined.
--
-- Security model:
--   - SECURITY DEFINER + explicit search_path (matches 0015 pattern).
--   - REVOKE EXECUTE from PUBLIC + authenticated + anon.
--   - GRANT EXECUTE only to service_role.
--   - service_role JWT is only used server-side (Inngest worker, webhook
--     handlers); never exposed to clients via supabase-js anon/authenticated
--     paths.
--   - Tenant isolation is preserved by the WHERE kc.clinic_id =
--     target_clinic_id filter — the caller (worker) is responsible for
--     passing the correct clinic_id, which it does via the dispatch's
--     conversation.clinic_id (already validated cross-tenant in the
--     dispatcher).
--
-- The user-facing search_knowledge_chunks remains untouched and still
-- enforces is_clinic_member for direct authenticated calls.
--
-- Mirrors the GRANT pattern of get_integration_credential_internal (0015).
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.search_knowledge_chunks_internal(
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
SET search_path = public, pg_catalog, pg_temp AS $$
BEGIN
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

REVOKE EXECUTE ON FUNCTION public.search_knowledge_chunks_internal(uuid, vector, int, uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.search_knowledge_chunks_internal(uuid, vector, int, uuid[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_knowledge_chunks_internal(uuid, vector, int, uuid[]) TO service_role;

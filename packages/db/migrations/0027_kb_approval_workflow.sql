-- ════════════════════════════════════════════════════════════════════════════
-- 0027_kb_approval_workflow.sql
--
-- AI-3.5b expandido: workflow de aprovação obrigatória pra knowledge_documents.
-- Sem aprovação explícita do admin/owner, doc NÃO é processado pelo worker
-- nem encontrado pelo agente IA. Defesa contra:
--   - Upload acidental que polui contexto IA
--   - PDF malicioso (futuro PR de PDF parsing)
--   - Mudança de contrato sem revisão humana
--
-- Mudanças:
--   1. Adiciona 4 colunas: approval_status, approved_by, approved_at,
--      rejection_reason
--   2. Backfill: rows existentes (sao-lucas seeded docs) → 'approved' pra
--      não quebrar agente
--   3. CREATE OR REPLACE search_knowledge_chunks_internal: JOIN
--      knowledge_documents + filter approval_status='approved' + archived_at
--      IS NULL — agente NUNCA usa docs não aprovados
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Colunas novas ──────────────────────────────────────────────────────────

ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending_approval';

ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS rejection_reason text;

ALTER TABLE public.knowledge_documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_approval_status_valid;

ALTER TABLE public.knowledge_documents
  ADD CONSTRAINT knowledge_documents_approval_status_valid
  CHECK (approval_status IN ('pending_approval', 'approved', 'rejected'));

-- Index pra UI tabs filter rápido (Pendentes/Aprovados/Rejeitados).
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_clinic_approval
  ON public.knowledge_documents (clinic_id, approval_status)
  WHERE archived_at IS NULL;

-- ─── Backfill: rows existentes → 'approved' ─────────────────────────────────
-- Defesa CRITICAL pra sao-lucas (3 docs seedados em produção). Sem isso, o
-- agente IA quebra imediatamente após esta migration ser aplicada (RPC
-- filtraria todos como pending_approval). Backfill explícito é idempotente.

UPDATE public.knowledge_documents
SET approval_status = 'approved',
    approved_at = COALESCE(indexed_at, created_at)
WHERE approval_status = 'pending_approval'
  AND status = 'indexed'
  AND archived_at IS NULL;

-- ─── search_knowledge_chunks_internal: filter approved only ─────────────────
-- INNER JOIN knowledge_documents pra acesso a approval_status + archived_at.
-- Performance: kc.document_id já é FK indexed; JOIN trivial. Filter por
-- approval_status usa idx_knowledge_documents_clinic_approval (criado acima).

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
  INNER JOIN public.knowledge_documents kd ON kd.id = kc.document_id
  WHERE kc.clinic_id = target_clinic_id
    AND kd.approval_status = 'approved'
    AND kd.archived_at IS NULL
    AND (document_filter IS NULL OR kc.document_id = ANY(document_filter))
  ORDER BY kc.embedding <=> query_embedding
  LIMIT top_k;
END;
$$;

-- Grants/REVOKEs preservados de 0017 (CREATE OR REPLACE não os reseta).

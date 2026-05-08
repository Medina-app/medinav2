-- ════════════════════════════════════════════════════════════════════════════
-- 0025_agent_configs_kb_similarity_threshold.sql
--
-- Issue #21: torna SIMILARITY_THRESHOLD do search_kb tool configuravel
-- per-clinic. Atual: hardcoded 0.4 em packages/ai/src/tools/search-kb.ts.
-- Apos esta migration: agent_configs.kb_similarity_threshold (numeric 3,2)
-- DEFAULT 0.4 com CHECK [0, 1]. Existing rows ganham 0.4 via DEFAULT
-- (NOT NULL + DEFAULT cobre INSERTs e ALTER TABLE retroage o default).
--
-- Trade-off documentado: 0.4 e o sweet spot empirico pra
-- text-embedding-3-small + PT-BR queries (PR #22 hotfix). Outras clinicas
-- podem tunar via UPDATE quando tiverem KB volume / linguajar diferente.
-- CHECK [0, 1] permite extremos 0 (matches everything) e 1 (matches nada
-- exceto identical) — decisao admin. Granularidade 0.01 (numeric(3,2))
-- e suficiente pra tuning manual; escalar pra (5,4) em PR futuro se
-- precisar mais precisao.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS kb_similarity_threshold NUMERIC(3, 2) NOT NULL DEFAULT 0.4;

ALTER TABLE public.agent_configs
  DROP CONSTRAINT IF EXISTS agent_configs_kb_similarity_threshold_valid;

ALTER TABLE public.agent_configs
  ADD CONSTRAINT agent_configs_kb_similarity_threshold_valid
  CHECK (kb_similarity_threshold >= 0.0 AND kb_similarity_threshold <= 1.0);

-- Backfill defensivo (DEFAULT cobre, mas garante invariante explicita).
UPDATE public.agent_configs
SET kb_similarity_threshold = 0.4
WHERE kb_similarity_threshold IS NULL;

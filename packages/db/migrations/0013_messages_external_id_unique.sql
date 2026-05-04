-- ════════════════════════════════════════════════════════════════════════════
-- 0013_messages_external_id_unique.sql
--
-- Promote idx_messages_clinic_external_id from a regular partial index to a
-- UNIQUE partial index, enforcing webhook idempotency at the database layer.
--
-- Rationale: @medina/chat's addMessage helper declared "(clinic_id, external_id)
-- idempotency" but the lookup was a SELECT-then-INSERT — a race window where
-- two concurrent Kapso retries with the same wamid both pass the SELECT and
-- both INSERT, leaving subsequent .maybeSingle() lookups broken with
-- "multiple rows returned" and double-counting unread_count via the
-- update_conversation_on_message trigger.
--
-- The partial WHERE external_id IS NOT NULL is preserved: outbound rows
-- inserted before the Kapso round-trip can have external_id = NULL, and
-- multiple such NULL rows must coexist (UNIQUE on a NULLable column without
-- the WHERE would block all but one).
--
-- Verified zero duplicates in messages on (clinic_id, external_id) before
-- applying (would otherwise fail to create UNIQUE INDEX).
-- ════════════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS public.idx_messages_clinic_external_id;

CREATE UNIQUE INDEX idx_messages_clinic_external_id
  ON public.messages (clinic_id, external_id)
  WHERE external_id IS NOT NULL;

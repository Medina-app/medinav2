-- ════════════════════════════════════════════════════════════════════════════
-- 0014_message_outbox_fields.sql
--
-- Adds retry tracking fields to messages for the CHAT-2 outbox/Inngest worker.
--
-- Schema reuse:
--   - delivery_error (text, nullable) already exists (0005:137) — reused as
--     the "last error message" field. No new column.
--   - outbox_status (text, nullable, CHECK pending|processing|sent|failed)
--     already exists (0005:138) — used as the queue state marker.
--   - idx_messages_outbox_worker (outbox_status, created_at WHERE outbox_status
--     IN ('pending','failed')) already exists (0005:155) — covers the worker
--     query path. No new index.
--
-- New columns:
--   - retry_count: int NOT NULL DEFAULT 0. Incremented by the Inngest function
--     onFailure handler after retries are exhausted, and reset to 0 by the
--     manual retryFailedMessageAction when a user clicks "Retentar".
--   - last_error_at: timestamptz nullable. Set together with delivery_error
--     when the worker records a failure. Distinct from created_at since the
--     row may be retried later, leaving created_at fixed.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz;

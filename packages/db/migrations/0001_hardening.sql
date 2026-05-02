-- Revoke CREATE privilege from PUBLIC on the public schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Remove all table access from the anon role (unauthenticated requests).
-- RLS policies are the sole access mechanism; no table-level fallback.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Remove implicit grants from authenticated role, then re-grant only DML.
-- This ensures RLS policies — not table-level grants — control access.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

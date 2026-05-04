-- ════════════════════════════════════════════════════════════════════════════
-- scripts/cleanup-test-data.sql
--
-- Manual one-shot cleanup for orphan test fixtures left in the dev DB by
-- automated tests across the monorepo. Idempotent, transactional, and
-- preserves the production-ish clinic 'sao-lucas' plus any clinic created
-- manually.
--
-- When to use:
--   - After a vitest run aborts mid-cleanup (TDD RED phase, ctrl-C, crash).
--   - Before a fresh test run if the previous one left orphans (FK
--     violations in cleanup helpers, races between packages running in
--     parallel against the same DB).
--
-- Status: @medina/chat's deleteTestClinic was made defensive in PR #2
-- (W3, commit 1642145), so per-clinic teardown is now best-effort. This
-- script remains the "break glass" path when global teardown in @medina/db
-- can't reach orphans, or when a future test package leaks fixtures
-- (see docs/post-chat-1-backlog.md item 2).
--
-- Usage: paste the whole file into Supabase SQL Editor and run.
--   Step 1 = preview (SELECTs only)
--   Step 2 = transactional DELETE + validation (BEGIN/COMMIT)
--   Step 3 = sanity check that sao-lucas is intact
-- ════════════════════════════════════════════════════════════════════════════


-- ─── Step 1 — Preview (DRY-RUN) ─────────────────────────────────────────────
-- Lists every test clinic that would be deleted by Step 2.
-- The regex matches every prefix used by chat + db tests' fixture helpers.
-- The slug != 'sao-lucas' filter is defense-in-depth against an accidental
-- clinic with a matching name.

SELECT id, name, slug, created_at
FROM public.clinics
WHERE slug != 'sao-lucas'
  AND name ~* '^(Isolation|Lookup|GetDetail|GetIso|ListPatientName|ListIso|ListAssigned|ListResolved|ListOrder|ConvCreate|ConvIdempotent|AddInbound|AddIdempotent|AddOutbound|UpdStatus|UpdMissing|Pat |Encrypt |Dec |Deny |RBAC |Audit |Slug |Onboard )'
ORDER BY name;


-- ─── Step 2 — Cleanup transaction ───────────────────────────────────────────
-- Runs the actual DELETEs inside a single transaction so we can ROLLBACK
-- by hand if the validation block at the end shows leftover rows.

BEGIN;

-- 2.1. Capture target clinic ids in a temp table for reuse across the deletes.
--      ON COMMIT DROP cleans up automatically when the transaction ends.
CREATE TEMP TABLE _to_delete ON COMMIT DROP AS
SELECT id FROM public.clinics
WHERE slug != 'sao-lucas'
  AND name ~* '^(Isolation|Lookup|GetDetail|GetIso|ListPatientName|ListIso|ListAssigned|ListResolved|ListOrder|ConvCreate|ConvIdempotent|AddInbound|AddIdempotent|AddOutbound|UpdStatus|UpdMissing|Pat |Encrypt |Dec |Deny |RBAC |Audit |Slug |Onboard )';

-- 2.2. clinic_integrations has a BEFORE DELETE trigger (soft_delete_integration)
--      that converts DELETE → UPDATE deleted_at = NOW() WHEN OLD.deleted_at IS
--      NULL. To hard-delete we first soft-delete (so the trigger guard fails
--      on the second pass), then DELETE for real.
UPDATE public.clinic_integrations
SET deleted_at = NOW()
WHERE clinic_id IN (SELECT id FROM _to_delete) AND deleted_at IS NULL;

DELETE FROM public.clinic_integrations
WHERE clinic_id IN (SELECT id FROM _to_delete);

-- 2.3. audit_logs has FK to clinics; clear test entries before clinic delete
--      (prevents stranded rows if FK is ON DELETE SET NULL).
DELETE FROM public.audit_logs
WHERE clinic_id IN (SELECT id FROM _to_delete);

-- 2.4. clinic_members would cascade with the clinic, but explicit DELETE is
--      faster and avoids walking large cascade graphs on the planner side.
DELETE FROM public.clinic_members
WHERE clinic_id IN (SELECT id FROM _to_delete);

-- 2.5. patients has a soft-delete trigger like clinic_integrations. Mark them
--      as deleted first so the cascade from clinics DELETE goes through cleanly.
UPDATE public.patients
SET deleted_at = NOW()
WHERE clinic_id IN (SELECT id FROM _to_delete) AND deleted_at IS NULL;

-- 2.6. Final clinic delete — CASCADE removes the remaining patients,
--      conversations, and messages (messages cascade via conversations FK).
DELETE FROM public.clinics WHERE id IN (SELECT id FROM _to_delete);

-- 2.7. auth.users created by inbox.test.ts via supabase.auth.admin.createUser.
--      Pattern is 'test-<uuid>@medina-test.internal'. Existing FKs from
--      conversations.assigned_user_id and clinic_members.user_id are ON DELETE
--      SET NULL / cascade, so this delete is safe even if some references
--      survived earlier failed cleanups.
DELETE FROM auth.users WHERE email LIKE '%@medina-test.internal';

-- 2.8. Validation — must return 0/0/0 before COMMIT. If anything > 0, ROLLBACK
--      (replace COMMIT below with ROLLBACK) and adjust the regex.
SELECT
  (SELECT count(*) FROM public.clinics
   WHERE slug != 'sao-lucas'
     AND name ~* '^(Isolation|Lookup|GetDetail|GetIso|ListPatientName|ListIso|ListAssigned|ListResolved|ListOrder|ConvCreate|ConvIdempotent|AddInbound|AddIdempotent|AddOutbound|UpdStatus|UpdMissing|Pat |Encrypt |Dec |Deny |RBAC |Audit |Slug |Onboard )'
  ) AS leftover_test_clinics,
  (SELECT count(*) FROM public.clinic_integrations
   WHERE name LIKE 'Test %'
  ) AS leftover_test_integrations,
  (SELECT count(*) FROM auth.users
   WHERE email LIKE '%@medina-test.internal'
  ) AS leftover_test_auth_users;

COMMIT;


-- ─── Step 3 — Sanity check: sao-lucas intact ────────────────────────────────
-- Confirms the production-ish clinic still has its Kapso integration row,
-- conversations, and patients (whatever you've inserted manually or via real
-- WhatsApp inbound webhooks).

SELECT
  c.id,
  c.name,
  c.slug,
  (SELECT count(*) FROM public.clinic_integrations
    WHERE clinic_id = c.id AND deleted_at IS NULL) AS active_integrations,
  (SELECT count(*) FROM public.conversations
    WHERE clinic_id = c.id AND deleted_at IS NULL) AS active_conversations,
  (SELECT count(*) FROM public.patients
    WHERE clinic_id = c.id AND deleted_at IS NULL) AS active_patients,
  (SELECT count(*) FROM public.clinic_members
    WHERE clinic_id = c.id) AS members
FROM public.clinics c
WHERE c.slug = 'sao-lucas';

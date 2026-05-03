# Post-Push Backlog — Security & Tech Debt

Items identified in pre-push code review. Not blocking push. Open Linear issues per sprint.

| # | Original Finding | Severity | Description | Effort | Sprint |
|---|---|---|---|---|---|
| B1 | #6 | WARNING | `listUsers()` without pagination in inviteMemberAction — fetches all platform users, OOM risk at scale | S | Settings sprint |
| B2 | #8 | WARNING | Onboarding clinic creation has no DB-level transaction — orphaned clinic possible if member insert fails | M | Auth hardening sprint |
| B3 | #11 | WARNING | Webhook test spies on `console.log` to validate structured logging — breaks if logger changes | S | Test quality sprint |
| B4 | #12 | WARNING | Missing plan files for issues 5, 6, 8, 9 | S | Docs sprint |
| B5 | #13 | WARNING | RLS policy for assigned_user conversations uses `auth.uid()` without SELECT wrap (0005_chat.sql:302,305) — low perf risk but should match codebase convention | S | Next migration batch |
| B6 | #15 | INFO | `createDefaultLookup()` in webhook-handler creates new Supabase client per cold start — use module-level singleton | XS | Integrations sprint |
| B7 | #16 | INFO | Tool stubs throw `Error('not yet implemented')` — should return structured no-op instead of crashing agent | S | Livechat sprint |

# packages/db/scripts

One-off operational scripts. Not part of CI; run manually when needed.

## seed-agent-config.ts

Seeds a default `agente-principal` agent_config (status=published) for a clinic.
Idempotent: if a published config already exists with that name, returns the existing id.

Required env vars (sourced automatically from the worktree's apps/web/.env.local):

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (service role bypasses RLS, audit log entry will have user_id=NULL)

Run from the repo root:

```bash
pnpm tsx packages/db/scripts/seed-agent-config.ts <clinic-id>
```

Output is a single JSON line: `{"created": true|false, "configId": "uuid", "clinicName": "..."}`

The default config uses:

- model: `anthropic/claude-sonnet-4-5` (via OpenRouter)
- temperature: 0.7, max_tokens: 1024
- empty tools, guardrails, knowledge_document_ids (those land in AI-2/3/5)
- system prompt: clinic-personalized template in Portuguese with WhatsApp-specific guidance

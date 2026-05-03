# @medina/integrations

Webhook routing and adapter pattern for external integrations (PEP, WhatsApp, Cal.com, etc.).

## Webhook URL pattern

```
POST /api/webhooks/{type}/{provider}/{clinic_id}
```

Example: `POST /api/webhooks/whatsapp/kapso/a1b2c3d4-...`

The `webhook_path` column on `clinic_integrations` is a GENERATED STORED column that always equals this pattern. The Next.js route at `apps/web/app/api/webhooks/[type]/[provider]/[clinicId]/route.ts` receives the request, looks up the integration row using `type + provider + clinic_id`, validates the HMAC signature, and dispatches to the registered adapter.

## Creating a new adapter

1. Create a package at `packages/integrations/{type}/{provider}/` with `package.json` (name: `@medina/integrations-{type}-{provider}`) and deps on `@medina/db` + `@medina/integrations-core`.
2. Export a `const adapter: AdapterInterface` from `src/adapter.ts`. Set `type`, `provider`, `signatureHeader`, `handle`, and `healthCheck`.
3. Register it in `apps/web/app/api/webhooks/[type]/[provider]/[clinicId]/route.ts` via `registry.register(adapter)`.
4. Add `"packages/integrations/{type}/*"` glob to `pnpm-workspace.yaml` if a new type directory is needed.
5. Write unit tests mocking `WebhookContext` — see `packages/integrations/core/tests/webhook-handler.test.ts` for the pattern.

## HMAC signature validation

Each provider sends its HMAC signature in a different HTTP header. Set `signatureHeader` on the adapter accordingly:

| Provider | Header |
|---|---|
| Kapso (WhatsApp) | `x-kapso-signature` |
| Cal.com | `x-cal-signature-256` |
| iClinic (PEP) | `x-iclinic-signature` |
| Generic | `x-medina-signature` |

`verifyHmacSignature(secret, rawBody, signature)` in `@medina/integrations-core` handles the `sha256=` prefix and uses `timingSafeEqual` for timing-safe comparison.

## Webhook handler behavior

| Condition | HTTP response |
|---|---|
| Integration not found | 404 |
| Integration disabled | 400 |
| Type/provider mismatch | 400 |
| Invalid HMAC signature | 401 |
| Adapter throws (any error) | **200** — logged, provider must not retry |
| Success | 200 |

The 200-on-adapter-error rule (idempotência) prevents webhook providers from retrying deliveries for transient internal failures. Errors are logged with full structured context for debugging.

## Testing an adapter locally

1. Start `pnpm dev` in `apps/web`.
2. Expose localhost with ngrok: `ngrok http 3000`.
3. Set the clinic's webhook URL in the provider's dashboard to `https://{ngrok-url}/api/webhooks/{type}/{provider}/{clinic_id}`.
4. Send a test payload from the provider's dashboard.

## Package overview

| Package | Purpose |
|---|---|
| `@medina/integrations` | Original types (IntegrationAdapter, AdapterContext) — kept for backward compat |
| `@medina/integrations-core` | Signature validation, adapter registry, webhook orchestrator |
| `@medina/integrations-whatsapp-kapso` | Kapso WhatsApp adapter skeleton |
| `@medina/integrations-calcom` | Cal.com adapter skeleton |
| `@medina/integrations-pep-iclinic` | iClinic PEP placeholder |

# @medina/integrations

Adapter pattern for external system integrations (PEP, WhatsApp, Cal.com, etc.).

## Webhook Routing

Inbound webhooks arrive at:

```
POST /api/webhooks/{type}/{provider}/{clinic_id}
```

Example: `POST /api/webhooks/whatsapp/cloud_api/a1b2c3d4-...`

The `webhook_path` column on `clinic_integrations` is a GENERATED STORED column
that always equals this pattern. The Next.js route handler at
`apps/web/app/api/webhooks/[type]/[provider]/[clinic_id]/route.ts` (to be created
in a future issue) will:

1. Look up the integration row using `type`, `provider`, and `clinic_id`
2. Load the `webhook_secret` from the row
3. Validate the HMAC signature (see below)
4. Dispatch to the correct adapter's `handle()` method

## HMAC Validation

Each integration has a `webhook_secret` (random string set at creation time).
To validate an inbound webhook:

```typescript
import { createHmac, timingSafeEqual } from 'crypto';

function validateWebhookSignature(
  payload: Buffer,
  receivedSig: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(receivedSig);
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}
```

The signature header name is provider-specific:
- WhatsApp Cloud API: `X-Hub-Signature-256` (prefix `sha256=`)
- iClinic: `X-iClinic-Signature`
- Generic: `X-Medina-Signature`

## Reading Credentials

Adapters receive an `AdapterContext` with a `getCredentials()` helper. Internally
it calls:

```sql
SELECT get_integration_credential($1::uuid)
```

This SECURITY DEFINER function validates the caller has `admin` or `owner` role
in the integration's clinic before decrypting with `app.encryption_key`.

The application server must set the encryption key before calling:

```typescript
await sql`SELECT set_config('app.encryption_key', ${process.env.ENCRYPTION_KEY}, TRUE)`;
const creds = JSON.parse(await context.getCredentials());
```

**Key rotation**: Update `app.encryption_key` in Supabase → Database → Configuration,
then run a one-time migration that re-encrypts all `encrypted_credentials` rows with
the new key.

## Adapter Contract

```typescript
// packages/integrations/src/adapters/{type}/{provider}.ts
import type { IntegrationAdapter } from '@medina/integrations';

export const adapter: IntegrationAdapter = {
  async handle(payload, context) { /* ... */ },
  async sync(context) { /* ... */ },
  async healthCheck(context) { /* ... */ },
};
```

## Directory Structure (future)

```
packages/integrations/
  src/
    types.ts            ← adapter interface (exists)
    adapters/
      whatsapp/
        cloud_api.ts    ← WhatsApp Cloud API adapter
      pep/
        iclinic.ts      ← iClinic PEP adapter
        feegow.ts
      calcom/
        cal.ts
```

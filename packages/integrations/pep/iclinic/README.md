# @medina/integrations-pep-iclinic

Placeholder for the iClinic PEP adapter. Implementation is scheduled for a future sprint.

## How to implement this adapter

1. Create `src/adapter.ts` exporting `const iClinicAdapter: AdapterInterface`.
2. Set `signatureHeader: 'x-iclinic-signature'` (confirm with iClinic docs before implementing).
3. Implement `handle(ctx)` — parse `ctx.payload`, map to Medina domain events.
4. Implement `healthCheck(integration)` — call `integration.getCredentials()` and ping iClinic API.
5. Register in the route file: `registry.register(iClinicAdapter)`.
6. Write unit tests in `tests/adapter.test.ts` following the pattern in `@medina/integrations-core/tests/webhook-handler.test.ts`.

## Webhook URL

```
POST /api/webhooks/pep/iclinic/{clinic_id}
```

## Add tsconfig.json when implementing

```json
{
  "extends": "../../../../tsconfig.json",
  "compilerOptions": { "lib": ["ES2022"], "moduleResolution": "bundler", "module": "esnext" },
  "include": ["src/**/*.ts", "tests/**/*.ts", "*.ts"]
}
```

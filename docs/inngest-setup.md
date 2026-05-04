# Inngest setup

Inngest powers the async outbound message worker (CHAT-2). This doc covers
local dev, production deployment, and branch environments.

## Local development

The Inngest CLI proxies events between the app and a local dev server, so
no cloud account or env keys are required for development.

In one terminal:

```bash
npx inngest-cli@latest dev
```

This starts a dev server on `http://localhost:8288` that:

- Discovers function definitions by polling `http://localhost:3000/api/inngest`.
- Receives events fired by the app (`inngest.send(...)`).
- Invokes the corresponding function handlers via the same `/api/inngest`
  endpoint.
- Provides a dashboard at `http://localhost:8288` to inspect runs, replay
  failed events, and trigger manual dispatches.

In a second terminal, run the app as usual (`pnpm dev`). When the app
starts, Inngest CLI auto-discovers the registered functions.

## Production (Vercel)

Set the following env vars in the Vercel project settings (production
environment):

- `INNGEST_EVENT_KEY` — for `inngest.send(...)` to authenticate dispatch.
- `INNGEST_SIGNING_KEY` — used by `/api/inngest` to verify incoming
  function invocations from Inngest cloud.

Both keys are obtained from the Inngest cloud dashboard
(`https://app.inngest.com`). Without them set, production dispatch fails
silently (events queue locally but never reach the cloud).

The first deploy with the keys configured will trigger Inngest cloud to
sync the app's function definitions automatically. Subsequent deploys with
new or changed functions sync on Vercel build.

## Branch environments (future)

Inngest supports per-branch environments — each PR gets its own isolated
event stream and function namespace. This is not configured yet; until it
is, all PR/preview deployments share the production environment, which can
be confusing during development. Tracked in
`docs/post-chat-1-backlog.md` (item not yet listed; will be added when
CHAT-2 merges).

## Functions registered

Currently empty (`apps/web/app/api/inngest/route.ts`). Functions are added
incrementally during CHAT-2:

- `process-outbound-message` — picks up `chat/message.outbound` events,
  decrypts integration credentials, POSTs to Kapso, persists `wamid` and
  `outbox_status='sent'`. Retries up to 5 with exponential backoff.
- `process-message-status` — picks up `chat/message.status_update` events
  and applies state transitions (with terminal-state regression guard).

## Reference

- [Inngest Next.js quickstart](https://www.inngest.com/docs/getting-started/nextjs-quick-start)
- [Function configuration](https://www.inngest.com/docs/reference/functions/create)
- [Event keys vs signing keys](https://www.inngest.com/docs/platform/signing-keys)

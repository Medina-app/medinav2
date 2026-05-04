import { Inngest } from 'inngest';

/**
 * Inngest client for the Medina app.
 *
 * Dev vs cloud mode is determined by the *presence* of INNGEST_EVENT_KEY,
 * not by NODE_ENV. Passing `eventKey: undefined` still puts the client in
 * cloud mode and breaks the local CLI sync with "Expected server kind
 * cloud, got dev". The fix is to only spread the option when the env var
 * is actually set — when unset, the client auto-detects dev mode and the
 * local Inngest CLI handles dispatch via http://localhost:8288.
 *
 * In production: Vercel env vars `INNGEST_EVENT_KEY` (event dispatch) and
 * `INNGEST_SIGNING_KEY` (read by the serve handler in route.ts to verify
 * incoming function invocations) must both be set. See docs/inngest-setup.md.
 */
const eventKey = process.env['INNGEST_EVENT_KEY'];

export const inngest = new Inngest({
  id: 'medina',
  ...(eventKey ? { eventKey } : {}),
});

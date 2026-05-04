import { Inngest } from 'inngest';

/**
 * Inngest client for the Medina app.
 *
 * In development: when INNGEST_EVENT_KEY is unset, the client falls back to
 * the local dev server discovered by `npx inngest-cli@latest dev` on
 * localhost:8288. No cloud env required for local development.
 *
 * In production: Vercel env vars `INNGEST_EVENT_KEY` (event dispatch) and
 * `INNGEST_SIGNING_KEY` (used by the route handler to verify incoming
 * function invocations) must be set. See docs/inngest-setup.md.
 */
export const inngest = new Inngest({
  id: 'medina',
  eventKey: process.env['INNGEST_EVENT_KEY'],
});

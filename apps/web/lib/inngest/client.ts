import { Inngest } from 'inngest';

/**
 * Inngest client for the Medina app.
 *
 * Dev vs cloud mode is forced by INNGEST_DEV — when set to '1', the client
 * (and any serve handler that inherits from it) runs in dev mode regardless
 * of whether EVENT_KEY/SIGNING_KEY happen to be present. This is the safe
 * default for local work: even a leaked prod key won't dispatch to cloud.
 *
 * Both signingKey and eventKey live on the client so the serve handler in
 * route.ts inherits them automatically — passing them on serve() instead
 * leaves the client itself unauthenticated for outbound dispatch.
 *
 * Production (Vercel): set INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY and
 * leave INNGEST_DEV unset. See docs/inngest-setup.md.
 */
export const inngest = new Inngest({
  id: 'medina',
  isDev: process.env['INNGEST_DEV'] === '1',
  eventKey: process.env['INNGEST_EVENT_KEY'],
  signingKey: process.env['INNGEST_SIGNING_KEY'],
});

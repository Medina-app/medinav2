'use client';

import { useEffect, useRef, useState } from 'react';
import { Centrifuge, UnauthorizedError, type Subscription } from 'centrifuge';

type Opts = {
  /** Channels the user has access to (allow-listed in the JWT). */
  channels: string[];
  /** Called on every relevant publication AND on each (re)connect. */
  onMessage: () => void;
  /** Master kill switch. When false, hook is a no-op. */
  enabled?: boolean;
  /**
   * Tenant slug used to scope the token request. The /api/realtime/token
   * endpoint reads this from the query string because middleware doesn't
   * inject x-tenant-slug into /api/* paths.
   */
  clinicSlug: string;
};

type State = {
  /** True while a Centrifuge connection is open. Drives polling fallback. */
  connected: boolean;
};

/**
 * Subscribes to the supplied Centrifugo channels and triggers `onMessage`
 * whenever a publication arrives. The handler is intentionally agnostic —
 * components pass `() => router.refresh()` and let Next.js re-fetch the
 * truth, so we never have to trust the WS payload.
 *
 * Reconnect strategy = poor man's history: every `connected` event fires
 * `onMessage` once so the UI catches up after a transient disconnect
 * without enabling Centrifugo's stateful history feature (which would
 * require Redis on the broker).
 */
export function useCentrifugo({
  channels,
  onMessage,
  enabled = true,
  clinicSlug,
}: Opts): State {
  const [connected, setConnected] = useState(false);

  // Keep the latest callback in a ref so the effect doesn't re-subscribe on
  // every render of the parent component.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // The channels join key: the effect only re-runs when the actual list
  // changes, not when the array identity flips.
  const channelsKey = channels.join('|');

  useEffect(() => {
    if (!enabled || channels.length === 0) return;

    const tokenUrl = `/api/realtime/token?clinicSlug=${encodeURIComponent(clinicSlug)}`;

    let cancelled = false;
    // Refs (object closures) so the cleanup branch can reach into state that
    // setup() populates AFTER the cleanup may have already fired. Without
    // this, `let centrifuge` captured `null` in the cleanup closure even when
    // setup() resumed past its awaits and built a real client — which leaked
    // a connected Centrifuge for the lifetime of the page.
    const state: { centrifuge: Centrifuge | null; subs: Subscription[] } = {
      centrifuge: null,
      subs: [],
    };

    function teardown() {
      state.subs.forEach((s) => s.unsubscribe());
      state.subs = [];
      state.centrifuge?.disconnect();
      state.centrifuge = null;
    }

    async function setup() {
      const tokenRes = await fetch(tokenUrl);
      if (cancelled) return;
      if (!tokenRes.ok) return;
      const first = (await tokenRes.json()) as { token: string; url: string };
      if (cancelled) return;

      const c = new Centrifuge(first.url, {
        token: first.token,
        // getToken fires when the current token is about to expire OR when
        // the server asks for a refresh. Throwing Error → centrifuge retries
        // (transient network / 5xx). Throwing UnauthorizedError → centrifuge
        // gives up and disconnects, which is what we want when membership
        // was revoked or the user signed out (server returns 401).
        getToken: async () => {
          const r = await fetch(tokenUrl);
          if (r.status === 401) {
            throw new UnauthorizedError('realtime token endpoint returned 401');
          }
          if (!r.ok) {
            throw new Error(`realtime token endpoint returned ${r.status}`);
          }
          const j = (await r.json()) as { token: string };
          return j.token;
        },
      });

      // If the effect was cancelled while we were constructing the client,
      // don't even wire it up — just dispose and bail.
      if (cancelled) {
        c.disconnect();
        return;
      }

      state.centrifuge = c;

      c.on('connected', () => {
        setConnected(true);
        onMessageRef.current();
      });
      c.on('disconnected', () => setConnected(false));

      for (const ch of channels) {
        const sub = c.newSubscription(ch);
        sub.on('publication', () => onMessageRef.current());
        sub.subscribe();
        state.subs.push(sub);
      }

      c.connect();
    }

    void setup();

    return () => {
      cancelled = true;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- channelsKey covers the array change
  }, [enabled, channelsKey, clinicSlug]);

  return { connected };
}

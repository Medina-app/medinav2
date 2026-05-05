'use client';

import { useEffect, useRef, useState } from 'react';
import { Centrifuge, type Subscription } from 'centrifuge';

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
    let centrifuge: Centrifuge | null = null;
    const subs: Subscription[] = [];

    async function setup() {
      const tokenRes = await fetch(tokenUrl);
      if (!tokenRes.ok || cancelled) return;
      const first = (await tokenRes.json()) as { token: string; url: string };

      centrifuge = new Centrifuge(first.url, {
        token: first.token,
        // getToken is invoked when the current token is about to expire OR
        // when the server tells us to refresh. Re-hits the same endpoint;
        // the server re-runs RLS so revoked memberships drop out naturally.
        getToken: async () => {
          const r = await fetch(tokenUrl);
          const j = (await r.json()) as { token: string };
          return j.token;
        },
      });

      centrifuge.on('connected', () => {
        setConnected(true);
        onMessageRef.current();
      });
      centrifuge.on('disconnected', () => setConnected(false));

      for (const ch of channels) {
        const sub = centrifuge.newSubscription(ch);
        sub.on('publication', () => onMessageRef.current());
        sub.subscribe();
        subs.push(sub);
      }

      centrifuge.connect();
    }

    void setup();

    return () => {
      cancelled = true;
      subs.forEach((s) => s.unsubscribe());
      centrifuge?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- channelsKey covers the array change
  }, [enabled, channelsKey, clinicSlug]);

  return { connected };
}

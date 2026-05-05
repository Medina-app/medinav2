import type { EventPayload } from './types';

export type PublisherDeps = {
  apiUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

/**
 * Synchronous publish — throws on any failure (HTTP non-2xx OR a 200 with
 * Centrifugo's JSON-RPC `error` field). Used in places where the caller
 * wants to know whether the broadcast succeeded (none today; reserved for
 * future test paths and for a possible /api/realtime/test endpoint).
 */
export async function publishToChannel(
  deps: PublisherDeps,
  channel: string,
  payload: EventPayload,
): Promise<void> {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(deps.apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `apikey ${deps.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      method: 'publish',
      params: { channel, data: payload },
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`centrifugo publish failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  if (json.error) {
    throw new Error(`centrifugo publish failed: ${json.error.message ?? 'unknown'}`);
  }
}

/**
 * Production path used by webhook handlers + Inngest workers. Publishes in
 * the background and swallows failures into a structured warn log so a
 * Centrifugo outage never blocks the upstream ACK (Kapso retries, worker
 * persists, etc). The DB stays the source of truth; missed pushes degrade
 * to the polling fallback in the inbox UI.
 */
export function publishToChannelFireAndForget(
  deps: PublisherDeps,
  channel: string,
  payload: EventPayload,
): void {
  publishToChannel(deps, channel, payload).catch((err) => {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        action: 'centrifugo_publish',
        channel,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  });
}

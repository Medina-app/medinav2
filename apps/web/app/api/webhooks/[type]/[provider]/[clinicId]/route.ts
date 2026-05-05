import { handleWebhook, registry } from '@medina/integrations-core';
import { kapsoAdapter } from '@medina/integrations-whatsapp-kapso';
import { calcomAdapter } from '@medina/integrations-calcom';
import {
  publishToChannelFireAndForget,
  type EventPayload,
  type PublisherDeps,
} from '@medina/realtime';
import { inngest } from '@/lib/inngest/client';

// Register at module load. Map.set is idempotent across HMR / cold starts.
registry.register(kapsoAdapter);
registry.register(calcomAdapter);

// Bind inngest.send so adapters can dispatch async work without holding
// a reference to the Inngest client. handleWebhook propagates this through
// WebhookContext.inngestSend; adapters that don't use it (calcom) ignore it.
const inngestSend = inngest.send.bind(inngest);

// Bind a fire-and-forget centrifugo publisher. The integrations layer types
// the payload as `unknown` to avoid a @medina/realtime dep; adapters carry
// the concrete EventPayload shape and we cast back here at the boundary.
function publisherDeps(): PublisherDeps {
  return {
    apiUrl: process.env['CENTRIFUGO_API_URL'] ?? '',
    apiKey: process.env['CENTRIFUGO_API_KEY'] ?? '',
  };
}

const publishEvent = (channel: string, payload: unknown): void =>
  publishToChannelFireAndForget(publisherDeps(), channel, payload as EventPayload);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ type: string; provider: string; clinicId: string }> },
): Promise<Response> {
  const { type, provider, clinicId } = await params;
  return handleWebhook(req, { type, provider, clinicId }, undefined, inngestSend, publishEvent);
}

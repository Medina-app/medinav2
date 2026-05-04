import { handleWebhook, registry } from '@medina/integrations-core';
import { kapsoAdapter } from '@medina/integrations-whatsapp-kapso';
import { calcomAdapter } from '@medina/integrations-calcom';
import { inngest } from '@/lib/inngest/client';

// Register at module load. Map.set is idempotent across HMR / cold starts.
registry.register(kapsoAdapter);
registry.register(calcomAdapter);

// Bind inngest.send so adapters can dispatch async work without holding
// a reference to the Inngest client. handleWebhook propagates this through
// WebhookContext.inngestSend; adapters that don't use it (calcom) ignore it.
const inngestSend = inngest.send.bind(inngest);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ type: string; provider: string; clinicId: string }> },
): Promise<Response> {
  const { type, provider, clinicId } = await params;
  return handleWebhook(req, { type, provider, clinicId }, undefined, inngestSend);
}

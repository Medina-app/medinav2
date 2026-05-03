import { handleWebhook, registry } from '@medina/integrations-core';
import { kapsoAdapter } from '@medina/integrations-whatsapp-kapso';
import { calcomAdapter } from '@medina/integrations-calcom';

// Register at module load. Map.set is idempotent across HMR / cold starts.
registry.register(kapsoAdapter);
registry.register(calcomAdapter);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ type: string; provider: string; clinicId: string }> },
): Promise<Response> {
  const { type, provider, clinicId } = await params;
  return handleWebhook(req, { type, provider, clinicId });
}

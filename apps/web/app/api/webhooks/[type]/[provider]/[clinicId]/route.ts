import { handleWebhook } from '@medina/integrations-core'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ type: string; provider: string; clinicId: string }> },
): Promise<Response> {
  const { type, provider, clinicId } = await params
  return handleWebhook(req, { type, provider, clinicId })
}

import type { ClinicIntegration } from '@medina/db'

export type IntegrationType = 'whatsapp' | 'pep' | 'calcom' | 'custom'

/**
 * Generic Inngest dispatch function injected into the WebhookContext for
 * adapters that need async work. Optional so adapters/entrypoints that don't
 * use Inngest (e.g. calcom adapter, future CLI tools, isolated tests) keep
 * working with no changes — they just leave the field undefined and never
 * read it. Adapters that DO depend on it (kapso status path) must check
 * presence and throw an explicit error if missing rather than silently no-op.
 */
export type InngestSendFn = (event: {
  name: string
  id?: string
  data: unknown
}) => Promise<unknown>

export type WebhookContext = {
  clinicId: string
  integration: ClinicIntegration
  payload: unknown
  headers: Record<string, string>
  rawBody: string
  inngestSend?: InngestSendFn
}

export type HandleResult = { processed: boolean; reason?: string }
export type HealthStatus = { healthy: boolean; message?: string }

export interface AdapterInterface {
  readonly type: IntegrationType
  readonly provider: string
  readonly signatureHeader: string
  handle(ctx: WebhookContext): Promise<HandleResult>
  healthCheck(integration: ClinicIntegration): Promise<HealthStatus>
}

import type { ClinicIntegration } from '@medina/db'

export type IntegrationType = 'whatsapp' | 'pep' | 'calcom' | 'custom'

export type WebhookContext = {
  clinicId: string
  integration: ClinicIntegration
  payload: unknown
  headers: Record<string, string>
  rawBody: string
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

import type {
  AdapterInterface,
  IntegrationType,
  WebhookContext,
  HandleResult,
  HealthStatus,
} from '@medina/integrations-core'
import type { ClinicIntegration } from '@medina/db'

export const kapsoAdapter: AdapterInterface = {
  type: 'whatsapp' as IntegrationType,
  provider: 'kapso',
  signatureHeader: 'x-kapso-signature',

  async handle(_ctx: WebhookContext): Promise<HandleResult> {
    return { processed: false, reason: 'not_implemented' }
  },

  async healthCheck(_integration: ClinicIntegration): Promise<HealthStatus> {
    return { healthy: false, message: 'not_implemented' }
  },
}

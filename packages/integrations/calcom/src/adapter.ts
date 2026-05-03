import type {
  AdapterInterface,
  IntegrationType,
  WebhookContext,
  HandleResult,
  HealthStatus,
} from '@medina/integrations-core'
import type { ClinicIntegration } from '@medina/db'

export const calcomAdapter: AdapterInterface = {
  type: 'calcom' as IntegrationType,
  provider: 'calcom',
  signatureHeader: 'x-cal-signature-256',

  async handle(_ctx: WebhookContext): Promise<HandleResult> {
    return { processed: false, reason: 'not_implemented' }
  },

  async healthCheck(_integration: ClinicIntegration): Promise<HealthStatus> {
    return { healthy: false, message: 'not_implemented' }
  },
}

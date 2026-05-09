/**
 * AI-4: Cal.com webhook adapter.
 *
 * Generic webhook route ([type]/[provider]/[clinicId]) já faz lookup +
 * signature validation HMAC SHA-256 (header x-cal-signature-256). Este
 * adapter apenas:
 *   1. Valida shape do payload (triggerEvent + payload.uid)
 *   2. Dispatcha Inngest event 'calcom/booking.received' com event ID
 *      idempotente `calcom:{uid}:{triggerEvent}` — replay do webhook
 *      colapsa pra mesma invocação do worker
 *
 * Triggers conhecidos: BOOKING_CREATED/CONFIRMED/RESCHEDULED/CANCELLED.
 * Outros (BOOKING_PAYMENT_INITIATED, MEETING_STARTED, etc.) → no-op.
 *
 * Worker `process-calcom-event` (apps/web/lib/inngest/functions/...) faz o
 * mapping pra appointments table.
 */
import {
  InngestDispatchError,
  type AdapterInterface,
  type IntegrationType,
  type WebhookContext,
  type HandleResult,
  type HealthStatus,
} from '@medina/integrations-core';
import type { ClinicIntegration } from '@medina/db';
import type { CalWebhookTrigger } from './types.js';

const KNOWN_TRIGGERS = new Set<CalWebhookTrigger>([
  'BOOKING_CREATED',
  'BOOKING_CONFIRMED',
  'BOOKING_RESCHEDULED',
  'BOOKING_CANCELLED',
]);

interface CalWebhookEnvelope {
  triggerEvent?: string;
  createdAt?: string;
  payload?: {
    uid?: string;
    bookingId?: number;
    eventTypeId?: number;
    startTime?: string;
    endTime?: string;
    attendees?: Array<{ email: string; name: string }>;
    cancellationReason?: string;
    rescheduleUid?: string;
    metadata?: Record<string, unknown>;
  };
}

function isCalEnvelope(p: unknown): p is CalWebhookEnvelope {
  return typeof p === 'object' && p !== null;
}

export const calcomAdapter: AdapterInterface = {
  type: 'calcom' as IntegrationType,
  provider: 'calcom',
  signatureHeader: 'x-cal-signature-256',

  async handle(ctx: WebhookContext): Promise<HandleResult> {
    if (!isCalEnvelope(ctx.payload)) {
      return { processed: false, reason: 'invalid_payload' };
    }
    const env = ctx.payload;
    const trigger = env.triggerEvent;
    const uid = env.payload?.uid;

    if (!trigger || !uid) {
      return { processed: false, reason: 'invalid_payload' };
    }
    if (!KNOWN_TRIGGERS.has(trigger as CalWebhookTrigger)) {
      return { processed: false, reason: 'unhandled_trigger' };
    }

    if (!ctx.inngestSend) {
      // Match kapso pattern — explicit error so silent drop is impossible.
      throw new InngestDispatchError(new Error('inngestSend not configured for calcom adapter'));
    }

    try {
      await ctx.inngestSend({
        name: 'calcom/booking.received',
        id: `calcom:${uid}:${trigger}`,
        data: {
          clinicId: ctx.clinicId,
          integrationId: ctx.integration.id,
          triggerEvent: trigger,
          uid,
          payload: env.payload,
        },
      });
    } catch (err) {
      throw new InngestDispatchError(err);
    }

    return { processed: true, reason: 'dispatched' };
  },

  async healthCheck(_integration: ClinicIntegration): Promise<HealthStatus> {
    // No-op: real health check seria GET /me na Cal.com API mas requer
    // credentials decryption. Webhook health = adapter registered + secret
    // present (validado pelo handleWebhook upstream).
    return { healthy: true, message: 'calcom adapter ready' };
  },
};

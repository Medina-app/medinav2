import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  type AdapterInterface,
  type WebhookContext,
  type HandleResult,
  type HealthStatus,
  type PublishEventFn,
  InngestDispatchError,
} from '@medina/integrations-core';
import {
  lookupOrCreatePatientByPhone,
  getOrCreateConversation,
  addMessage,
} from '@medina/chat';
import { parseInboundMessage, parseStatusUpdate } from './parse';

// PublishEventFn is contracted as `=> void` (fire-and-forget) but the wiring
// at apps/web/.../webhooks/[...].ts builds it from publishToChannelFireAndForget,
// which already swallows async failures. The remaining failure mode is a
// synchronous throw before the publisher even queues the request (bad config,
// bad fetch impl). Wrap so a Centrifugo glitch never breaks webhook ACK —
// the DB has the message, the inbox falls back to polling.
function safePublish(
  publish: PublishEventFn | undefined,
  channel: string,
  payload: unknown,
  ctx: { clinicId: string; integrationId: string },
): void {
  if (!publish) return;
  try {
    publish(channel, payload);
  } catch (err) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        action: 'publishEvent_threw',
        channel,
        clinic_id: ctx.clinicId,
        integration_id: ctx.integrationId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function makeAdminSupabase(): SupabaseClient {
  return createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function persistInbound(
  sb: SupabaseClient,
  ctx: WebhookContext,
  inbound: NonNullable<ReturnType<typeof parseInboundMessage>>,
): Promise<HandleResult> {
  const { patient } = await lookupOrCreatePatientByPhone(
    sb,
    ctx.clinicId,
    inbound.fromPhone,
    inbound.patientNameHint,
  );

  const { conversation } = await getOrCreateConversation(sb, {
    clinicId: ctx.clinicId,
    integrationId: ctx.integration.id,
    channel: 'whatsapp',
    externalId: inbound.fromPhone,
    patientId: patient.id,
  });

  const { message, created } = await addMessage(sb, {
    clinicId: ctx.clinicId,
    conversationId: conversation.id,
    direction: 'inbound',
    senderType: 'patient',
    senderUserId: null,
    contentType: inbound.contentType,
    content: inbound.content,
    externalId: inbound.externalMessageId,
    deliveryStatus: 'delivered',
  });

  // Lazy-capture phone_number_id into clinic_integrations.config so outbound
  // sends can target the right Meta phone number without manual config.
  const cfg = (ctx.integration.config ?? {}) as Record<string, unknown>;
  if (cfg['phone_number_id'] !== inbound.phoneNumberId) {
    await sb
      .from('clinic_integrations')
      .update({ config: { ...cfg, phone_number_id: inbound.phoneNumberId } })
      .eq('id', ctx.integration.id);
  }

  // Realtime push only on a real insert — duplicates already fired their
  // push on the original delivery, no need to wake the inbox up again.
  // Channel format mirrors @medina/realtime/buildConversationChannel and
  // buildInboxChannel — kept inline here so packages/integrations/* doesn't
  // need to depend on @medina/realtime (the WebhookContext.publishEvent
  // payload is `unknown` for the same decoupling reason).
  //
  // Two publishes: the conversation channel wakes a subscriber that has the
  // detail open, and the inbox channel wakes the InboxRealtimeWrapper so the
  // sidebar's last_message_at + unread_count refresh even when no detail is
  // currently mounted.
  if (created) {
    const evt = {
      type: 'message.new' as const,
      conversationId: conversation.id,
      messageId: message.id,
      clinicId: ctx.clinicId,
    };
    const logCtx = { clinicId: ctx.clinicId, integrationId: ctx.integration.id };
    safePublish(ctx.publishEvent, `conv:${conversation.id}`, evt, logCtx);
    safePublish(ctx.publishEvent, `inbox:${ctx.clinicId}`, evt, logCtx);
  }

  return { processed: true, reason: created ? 'message_inserted' : 'duplicate_idempotent' };
}

export const kapsoAdapter: AdapterInterface = {
  type: 'whatsapp',
  provider: 'kapso',
  signatureHeader: 'x-webhook-signature',

  async handle(ctx: WebhookContext): Promise<HandleResult> {
    const sb = makeAdminSupabase();

    // Event type comes from the X-Webhook-Event HTTP header per Kapso docs.
    // Body shape is the same across received/sent/delivered/read/failed; only
    // the header + message.kapso.{direction,status} differ.
    const event = ctx.headers['x-webhook-event'];

    const inbound = parseInboundMessage(event, ctx.payload);
    if (inbound) return persistInbound(sb, ctx, inbound);

    const status = parseStatusUpdate(event, ctx.payload);
    if (status) {
      // CHAT-2: dispatch to Inngest instead of writing inline. The worker
      // (process-message-status) calls @medina/chat's updateMessageDeliveryStatus
      // with the terminal-state regression guard. Explicit error if the
      // entrypoint forgot to inject inngestSend — silent fallback would be
      // worse (lost status updates).
      if (!ctx.inngestSend) {
        throw new Error('inngestSend not configured for status path');
      }
      try {
        await ctx.inngestSend({
          name: 'chat/message.status_update',
          id: `status:${status.externalMessageId}:${status.status}`,
          data: {
            clinicId: ctx.clinicId,
            externalMessageId: status.externalMessageId,
            status: status.status,
            deliveryError: status.deliveryError,
          },
        });
      } catch (err) {
        throw new InngestDispatchError(err);
      }
      return { processed: true, reason: 'status_dispatched' };
    }

    return { processed: false, reason: 'unhandled_event' };
  },

  async healthCheck(): Promise<HealthStatus> {
    return { healthy: true, message: 'kapso adapter ready' };
  },
};

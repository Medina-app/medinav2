import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AdapterInterface,
  WebhookContext,
  HandleResult,
  HealthStatus,
} from '@medina/integrations-core';
import {
  lookupOrCreatePatientByPhone,
  getOrCreateConversation,
  addMessage,
  updateMessageDeliveryStatus,
} from '@medina/chat';
import { parseInboundMessage, parseStatusUpdate } from './parse';

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

  const { created } = await addMessage(sb, {
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
      const { updated } = await updateMessageDeliveryStatus(sb, ctx.clinicId, status);
      return {
        processed: updated,
        reason: updated ? 'status_updated' : 'message_not_found',
      };
    }

    return { processed: false, reason: 'unhandled_event' };
  },

  async healthCheck(): Promise<HealthStatus> {
    return { healthy: true, message: 'kapso adapter ready' };
  },
};

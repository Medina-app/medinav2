import type { InboundMessageEvent, StatusUpdateEvent } from '@medina/chat';
import { KapsoWebhookPayloadSchema, type KapsoWebhookPayload } from './types.js';

const ATTACHMENT_PLACEHOLDER = '[Anexo não exibido — suporte em CHAT-4]';

const STATUS_EVENT_MAP: Record<string, StatusUpdateEvent['status']> = {
  'whatsapp.message.sent': 'sent',
  'whatsapp.message.delivered': 'delivered',
  'whatsapp.message.read': 'read',
  'whatsapp.message.failed': 'failed',
};

const DB_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'image',
  'audio',
  'video',
  'document',
]);

function safeParse(raw: unknown): KapsoWebhookPayload | null {
  const parsed = KapsoWebhookPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseInboundMessage(raw: unknown): InboundMessageEvent | null {
  const payload = safeParse(raw);
  if (!payload || payload.type !== 'whatsapp.message.received') return null;

  const m = payload.data.message;
  if (!m.from) return null;

  const contentType: InboundMessageEvent['contentType'] = DB_CONTENT_TYPES.has(m.type)
    ? (m.type as InboundMessageEvent['contentType'])
    : 'system';

  const content = m.type === 'text' && m.text?.body ? m.text.body : ATTACHMENT_PLACEHOLDER;

  return {
    kind: 'inbound_message',
    externalMessageId: m.id,
    fromPhone: m.from,
    contentType,
    content,
    receivedAt: new Date(Number(m.timestamp) * 1000),
    phoneNumberId: payload.data.phone_number_id,
    kapsoConversationId: payload.data.conversation?.id,
  };
}

export function parseStatusUpdate(raw: unknown): StatusUpdateEvent | null {
  const payload = safeParse(raw);
  if (!payload) return null;

  const status = STATUS_EVENT_MAP[payload.type];
  if (!status) return null;

  const m = payload.data.message;
  const deliveryError =
    status === 'failed' ? m.errors?.[0]?.message : undefined;

  return {
    kind: 'status_update',
    externalMessageId: m.id,
    status,
    deliveryError,
  };
}

export function extractPhoneNumberId(raw: unknown): string | null {
  const payload = safeParse(raw);
  return payload?.data.phone_number_id ?? null;
}

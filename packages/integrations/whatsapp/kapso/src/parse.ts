import type { InboundMessageEvent, StatusUpdateEvent } from '@medina/chat';
import { KapsoMessageEventPayloadSchema, type KapsoMessageEventPayload } from './types';

const ATTACHMENT_PLACEHOLDER = '[Anexo não exibido — suporte em CHAT-4]';

const DB_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'image',
  'audio',
  'video',
  'document',
]);

const STATUS_HEADERS: ReadonlySet<string> = new Set([
  'whatsapp.message.sent',
  'whatsapp.message.delivered',
  'whatsapp.message.read',
  'whatsapp.message.failed',
]);

/** Kapso sends phones like '5581987654321' (no +). Normalize to E.164. */
function normalizeE164(phone: string): string {
  return phone.startsWith('+') ? phone : `+${phone}`;
}

export function parseMessageEventPayload(raw: unknown): KapsoMessageEventPayload | null {
  const r = KapsoMessageEventPayloadSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function parseInboundMessage(
  event: string | undefined,
  raw: unknown,
): InboundMessageEvent | null {
  if (event !== 'whatsapp.message.received') return null;
  const payload = parseMessageEventPayload(raw);
  if (!payload) return null;

  const m = payload.message;
  if (!m.from) return null;

  const dbType: InboundMessageEvent['contentType'] = DB_CONTENT_TYPES.has(m.type)
    ? (m.type as InboundMessageEvent['contentType'])
    : 'system';

  const content =
    m.type === 'text' && m.text?.body ? m.text.body : ATTACHMENT_PLACEHOLDER;

  return {
    kind: 'inbound_message',
    externalMessageId: m.id,
    fromPhone: normalizeE164(m.from),
    contentType: dbType,
    content,
    receivedAt: new Date(Number(m.timestamp) * 1000),
    phoneNumberId: payload.phone_number_id,
    kapsoConversationId: payload.conversation?.id,
    patientNameHint: payload.conversation?.contact_name ?? null,
  };
}

export function parseStatusUpdate(
  event: string | undefined,
  raw: unknown,
): StatusUpdateEvent | null {
  if (!event || !STATUS_HEADERS.has(event)) return null;
  const payload = parseMessageEventPayload(raw);
  if (!payload) return null;

  const status = event.replace('whatsapp.message.', '') as StatusUpdateEvent['status'];
  const m = payload.message;
  const deliveryError = status === 'failed' ? m.errors?.[0]?.message : undefined;

  return {
    kind: 'status_update',
    externalMessageId: m.id,
    status,
    deliveryError,
  };
}

export function extractPhoneNumberId(raw: unknown): string | null {
  const payload = parseMessageEventPayload(raw);
  return payload?.phone_number_id ?? null;
}

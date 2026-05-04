import type { Conversation, Message, Patient } from '@medina/db';

// Domain events — produced by integration adapters (kapso, future channels).
export type InboundMessageEvent = {
  kind: 'inbound_message';
  externalMessageId: string;
  fromPhone: string;
  contentType: 'text' | 'image' | 'audio' | 'video' | 'document' | 'system';
  content: string;
  receivedAt: Date;
  phoneNumberId: string;
  kapsoConversationId: string | undefined;
  /** Display name from the source channel (e.g. WhatsApp profile name).
   *  Used as full_name when creating a new patient; ignored if patient
   *  already exists (preserves user-edited names). */
  patientNameHint: string | null;
};

export type StatusUpdateEvent = {
  kind: 'status_update';
  externalMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  deliveryError: string | undefined;
};

// UI projection types — denormalized for inbox list and detail panel.
export type ConversationListItem = Pick<
  Conversation,
  'id' | 'state' | 'lastMessageAt' | 'lastMessagePreview' | 'unreadCount' | 'externalId' | 'patientId'
> & { patientName: string | null };

export type ConversationWithMessages = Conversation & {
  patient: Pick<Patient, 'id' | 'fullName' | 'phone' | 'preferredName'> | null;
  messages: Message[];
};

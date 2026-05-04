import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { conversations } from './conversations.js';

export type MessageDirection = 'inbound' | 'outbound';
export type MessageSenderType = 'patient' | 'ai' | 'human' | 'system';
export type MessageContentType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'template'
  | 'system';
export type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
export type OutboxStatus = 'pending' | 'processing' | 'sent' | 'failed';

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    clinicId: uuid('clinic_id').notNull(),
    direction: text('direction').$type<MessageDirection>().notNull(),
    senderType: text('sender_type').$type<MessageSenderType>().notNull(),
    senderUserId: uuid('sender_user_id'),
    contentType: text('content_type').$type<MessageContentType>().notNull(),
    content: text('content'),
    mediaUrl: text('media_url'),
    mediaMetadata: jsonb('media_metadata'),
    templateName: text('template_name'),
    templateVariables: jsonb('template_variables'),
    externalId: text('external_id'),
    deliveryStatus: text('delivery_status')
      .$type<DeliveryStatus>()
      .notNull()
      .default('pending'),
    deliveryError: text('delivery_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    outboxStatus: text('outbox_status').$type<OutboxStatus | null>(),
    retryCount: integer('retry_count').notNull().default(0),
    aiMetadata: jsonb('ai_metadata'),
    agentConfigId: uuid('agent_config_id'),
    inReplyTo: uuid('in_reply_to').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_messages_conversation_created_at').on(t.conversationId, t.createdAt),
    index('idx_messages_clinic_external_id')
      .on(t.clinicId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    index('idx_messages_outbox_worker')
      .on(t.outboxStatus, t.createdAt)
      .where(sql`${t.outboxStatus} IN ('pending','failed')`),
    index('idx_messages_delivery_status')
      .on(t.deliveryStatus)
      .where(sql`${t.deliveryStatus} IN ('pending','failed')`),
    check(
      'messages_direction_check',
      sql`${t.direction} IN ('inbound','outbound')`,
    ),
    check(
      'messages_sender_type_check',
      sql`${t.senderType} IN ('patient','ai','human','system')`,
    ),
    check(
      'messages_content_type_check',
      sql`${t.contentType} IN ('text','image','audio','video','document','template','system')`,
    ),
    check(
      'messages_delivery_status_check',
      sql`${t.deliveryStatus} IN ('pending','sent','delivered','read','failed')`,
    ),
    check(
      'messages_outbox_status_check',
      sql`${t.outboxStatus} IS NULL OR ${t.outboxStatus} IN ('pending','processing','sent','failed')`,
    ),
  ],
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

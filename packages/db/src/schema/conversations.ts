import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clinics } from './clinics.js';
import { clinicIntegrations } from './clinic-integrations.js';
import { patients } from './patients.js';

export type ConversationState =
  | 'ai_handling'
  | 'awaiting_template_response'
  | 'waiting_human'
  | 'assigned'
  | 'paused'
  | 'resolved';

export type ConversationChannel = 'whatsapp' | 'webchat' | 'instagram' | 'sms';

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'set null' }),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => clinicIntegrations.id, { onDelete: 'restrict' }),
    channel: text('channel').$type<ConversationChannel>().notNull(),
    externalId: text('external_id').notNull(),
    state: text('state').$type<ConversationState>().notNull().default('ai_handling'),
    escalatedVia: text('escalated_via').$type<'ai' | 'manual' | null>(),
    escalatedReason: text('escalated_reason').$type<
      'medication' | 'diagnosis' | 'urgency' | 'symptom' | 'other' | null
    >(),
    assignedUserId: uuid('assigned_user_id'),
    aiEnabled: boolean('ai_enabled').notNull().default(true),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastMessagePreview: text('last_message_preview'),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),
    unreadCount: integer('unread_count').notNull().default(0),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    metadata: jsonb('metadata').notNull().default({}),
    pinned: boolean('pinned').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_conversations_clinic_state_last_msg')
      .on(t.clinicId, t.state, t.lastMessageAt)
      .where(sql`${t.deletedAt} IS NULL`),
    index('idx_conversations_clinic_assigned_last_msg')
      .on(t.clinicId, t.assignedUserId, t.lastMessageAt)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('idx_conversations_clinic_integration_external_unique')
      .on(t.clinicId, t.integrationId, t.externalId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('idx_conversations_clinic_patient')
      .on(t.clinicId, t.patientId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('idx_conversations_clinic_archived')
      .on(t.clinicId, t.archivedAt)
      .where(sql`${t.archivedAt} IS NOT NULL`),
    index('idx_conversations_clinic_inbox')
      .on(t.clinicId, t.lastMessageAt)
      .where(
        sql`${t.state} IN ('ai_handling','waiting_human','assigned') AND ${t.deletedAt} IS NULL`,
      ),
    check(
      'conversations_channel_check',
      sql`${t.channel} IN ('whatsapp','webchat','instagram','sms')`,
    ),
    check(
      'conversations_state_check',
      sql`${t.state} IN ('ai_handling','awaiting_template_response','waiting_human','assigned','paused','resolved')`,
    ),
    check(
      'conversations_escalated_via_valid',
      sql`${t.escalatedVia} IS NULL OR ${t.escalatedVia} IN ('ai','manual')`,
    ),
    // AI-5: structured guardrail escalation category. NULL when escalation
    // came via tool-call (LLM chose to escalate) — só populado por
    // escalate_conversation_with_reason RPC (pre-filter / urgency / post-filter).
    check(
      'conversations_escalated_reason_valid',
      sql`${t.escalatedReason} IS NULL OR ${t.escalatedReason} IN ('medication','diagnosis','urgency','symptom','other')`,
    ),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

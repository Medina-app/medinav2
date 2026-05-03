import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clinics } from './clinics.js';
import { pipelines } from './pipelines.js';
import { pipelineStages } from './pipeline-stages.js';
import { patients } from './patients.js';
import { conversations } from './conversations.js';

export type DealPriority = 'low' | 'normal' | 'high' | 'urgent';
export type DealSource = 'whatsapp' | 'manual' | 'imported' | 'website';

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStages.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    value: numeric('value', { precision: 12, scale: 2 }),
    expectedCloseDate: date('expected_close_date'),
    position: integer('position').notNull().default(0),
    assignedUserId: uuid('assigned_user_id'),
    priority: text('priority').$type<DealPriority>().notNull().default('normal'),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    source: text('source').$type<DealSource>(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    wonAt: timestamp('won_at', { withTimezone: true }),
    lostAt: timestamp('lost_at', { withTimezone: true }),
    lostReason: text('lost_reason'),
    metadata: jsonb('metadata').notNull().default({}),
    createdBy: uuid('created_by'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_deals_clinic_pipeline_stage_position')
      .on(t.clinicId, t.pipelineId, t.stageId, t.position)
      .where(sql`${t.archivedAt} IS NULL`),
    index('idx_deals_clinic_assigned')
      .on(t.clinicId, t.assignedUserId)
      .where(sql`${t.archivedAt} IS NULL`),
    index('idx_deals_clinic_patient')
      .on(t.clinicId, t.patientId)
      .where(sql`${t.archivedAt} IS NULL AND ${t.patientId} IS NOT NULL`),
    index('idx_deals_clinic_conversation')
      .on(t.clinicId, t.conversationId)
      .where(sql`${t.archivedAt} IS NULL AND ${t.conversationId} IS NOT NULL`),
    check('deals_title_length_check', sql`char_length(${t.title}) BETWEEN 1 AND 200`),
    check('deals_priority_check', sql`${t.priority} IN ('low','normal','high','urgent')`),
    check('deals_source_check', sql`${t.source} IN ('whatsapp','manual','imported','website')`),
  ],
);

export type Deal = typeof deals.$inferSelect;
export type NewDeal = typeof deals.$inferInsert;

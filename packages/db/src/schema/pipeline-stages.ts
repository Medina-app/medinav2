import {
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
import { clinics } from './clinics.js';
import { pipelines } from './pipelines.js';

export type StageType = 'open' | 'won' | 'lost';

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    position: integer('position').notNull().default(0),
    color: text('color'),
    stageType: text('stage_type').$type<StageType>().notNull().default('open'),
    automationRules: jsonb('automation_rules').notNull().default({}),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_pipeline_stages_clinic_pipeline_position')
      .on(t.clinicId, t.pipelineId, t.position)
      .where(sql`${t.archivedAt} IS NULL`),
    index('idx_pipeline_stages_clinic_pipeline_type')
      .on(t.clinicId, t.pipelineId, t.stageType),
    check('pipeline_stages_name_length_check', sql`char_length(${t.name}) BETWEEN 1 AND 100`),
    check('pipeline_stages_type_check', sql`${t.stageType} IN ('open','won','lost')`),
  ],
);

export type PipelineStage = typeof pipelineStages.$inferSelect;
export type NewPipelineStage = typeof pipelineStages.$inferInsert;

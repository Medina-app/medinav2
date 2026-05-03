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

export const pipelines = pgTable(
  'pipelines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color').notNull().default('#06B6D4'),
    position: integer('position').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_pipelines_clinic_position')
      .on(t.clinicId, t.position)
      .where(sql`${t.archivedAt} IS NULL`),
    uniqueIndex('idx_pipelines_clinic_default_unique')
      .on(t.clinicId)
      .where(sql`${t.isDefault} = true AND ${t.archivedAt} IS NULL`),
    check('pipelines_name_length_check', sql`char_length(${t.name}) BETWEEN 1 AND 100`),
    check('pipelines_color_check', sql`${t.color} ~ '^#[0-9A-Fa-f]{6}$'`),
  ],
);

export type Pipeline = typeof pipelines.$inferSelect;
export type NewPipeline = typeof pipelines.$inferInsert;

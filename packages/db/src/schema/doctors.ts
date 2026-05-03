import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clinics } from './clinics.js';

export const doctors = pgTable(
  'doctors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    userId: uuid('user_id'),
    fullName: text('full_name').notNull(),
    specialty: text('specialty'),
    crm: text('crm'),
    crmState: text('crm_state'),
    email: text('email'),
    phone: text('phone'),
    bio: text('bio'),
    avatarUrl: text('avatar_url'),
    color: text('color').notNull().default('#06B6D4'),
    calcomUserId: text('calcom_user_id'),
    calcomEventTypeIds: text('calcom_event_type_ids').array(),
    consultationDurationMinutes: integer('consultation_duration_minutes').notNull().default(30),
    consultationPrice: numeric('consultation_price', { precision: 10, scale: 2 }),
    acceptsInsurance: boolean('accepts_insurance').notNull().default(false),
    active: boolean('active').notNull().default(true),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_doctors_clinic_active')
      .on(t.clinicId, t.active)
      .where(sql`${t.archivedAt} IS NULL`),
    index('idx_doctors_clinic_user')
      .on(t.clinicId, t.userId)
      .where(sql`${t.userId} IS NOT NULL AND ${t.archivedAt} IS NULL`),
    uniqueIndex('idx_doctors_clinic_calcom_user')
      .on(t.clinicId, t.calcomUserId)
      .where(sql`${t.calcomUserId} IS NOT NULL AND ${t.archivedAt} IS NULL`),
    check('doctors_full_name_length_check', sql`char_length(${t.fullName}) BETWEEN 1 AND 200`),
    check('doctors_color_hex_check', sql`${t.color} ~ '^#[0-9A-Fa-f]{6}$'`),
  ],
);

export type Doctor = typeof doctors.$inferSelect;
export type NewDoctor = typeof doctors.$inferInsert;

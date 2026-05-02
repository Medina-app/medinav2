import { pgTable, uuid, text, timestamp, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clinics } from './clinics.js';

export const clinicMembers = pgTable(
  'clinic_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id').notNull().references(() => clinics.id),
    userId: uuid('user_id').notNull(),
    role: text('role').notNull().default('member'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.clinicId, t.userId),
    check(
      'clinic_members_role_check',
      sql`${t.role} IN ('owner','admin','member')`,
    ),
  ],
);

export type ClinicMember = typeof clinicMembers.$inferSelect;
export type NewClinicMember = typeof clinicMembers.$inferInsert;

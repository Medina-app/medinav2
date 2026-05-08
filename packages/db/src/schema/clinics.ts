import { pgTable, uuid, text, timestamp, jsonb, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { BusinessHours } from '../types/business-hours.js';

export const clinics = pgTable(
  'clinics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    plan: text('plan').notNull().default('trial'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
    businessHours: jsonb('business_hours').$type<BusinessHours>().notNull().default({} as BusinessHours),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'clinics_plan_check',
      sql`${t.plan} IN ('trial','starter','pro','enterprise')`,
    ),
  ],
);

export type Clinic = typeof clinics.$inferSelect;
export type NewClinic = typeof clinics.$inferInsert;
export type { BusinessHours, DayHours, DayOfWeek } from '../types/business-hours.js';

import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appointments } from './appointments.js';

export type ReminderChannel = 'whatsapp' | 'sms' | 'email';
export type ReminderStatus = 'scheduled' | 'sent' | 'delivered' | 'failed' | 'cancelled';

export const appointmentReminders = pgTable(
  'appointment_reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    clinicId: uuid('clinic_id').notNull(),
    channel: text('channel').$type<ReminderChannel>().notNull(),
    templateName: text('template_name'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    responseAt: timestamp('response_at', { withTimezone: true }),
    responseContent: text('response_content'),
    status: text('status').$type<ReminderStatus>().notNull().default('scheduled'),
    errorMessage: text('error_message'),
    inngestEventId: text('inngest_event_id'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_reminders_clinic_scheduled')
      .on(t.clinicId, t.scheduledAt)
      .where(sql`${t.status} = 'scheduled'`),
    index('idx_reminders_appointment_channel').on(t.appointmentId, t.channel),
    index('idx_reminders_clinic_status_scheduled')
      .on(t.clinicId, t.status, t.scheduledAt)
      .where(sql`${t.status} IN ('scheduled','failed')`),
    check('reminders_channel_check', sql`${t.channel} IN ('whatsapp','sms','email')`),
    check(
      'reminders_status_check',
      sql`${t.status} IN ('scheduled','sent','delivered','failed','cancelled')`,
    ),
  ],
);

export type AppointmentReminder = typeof appointmentReminders.$inferSelect;
export type NewAppointmentReminder = typeof appointmentReminders.$inferInsert;

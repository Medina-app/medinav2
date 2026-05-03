import {
  check,
  index,
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
import { doctors } from './doctors.js';
import { patients } from './patients.js';
import { conversations } from './conversations.js';
import { deals } from './deals.js';

export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'no_show'
  | 'cancelled_by_patient'
  | 'cancelled_by_clinic'
  | 'rescheduled';

export type AppointmentType = 'consultation' | 'follow_up' | 'procedure' | 'exam' | 'other';
export type AppointmentModality = 'in_person' | 'telemedicine';
export type PaymentStatus = 'pending' | 'paid' | 'partial' | 'refunded' | 'waived';
export type AppointmentCreatedVia =
  | 'manual'
  | 'whatsapp'
  | 'website'
  | 'calcom_external'
  | 'pep_sync';
export type PepSyncStatus = 'pending' | 'synced' | 'failed';

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    doctorId: uuid('doctor_id')
      .notNull()
      .references(() => doctors.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id').references(() => patients.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    dealId: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    status: text('status').$type<AppointmentStatus>().notNull().default('scheduled'),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    timezone: text('timezone').notNull().default('America/Sao_Paulo'),
    type: text('type').$type<AppointmentType>().notNull().default('consultation'),
    modality: text('modality').$type<AppointmentModality>().notNull().default('in_person'),
    meetingUrl: text('meeting_url'),
    location: text('location'),
    notes: text('notes'),
    price: numeric('price', { precision: 10, scale: 2 }),
    paymentStatus: text('payment_status').$type<PaymentStatus>().notNull().default('pending'),
    calcomBookingId: text('calcom_booking_id'),
    calcomUid: text('calcom_uid'),
    pepExternalId: text('pep_external_id'),
    pepProvider: text('pep_provider'),
    pepSyncedAt: timestamp('pep_synced_at', { withTimezone: true }),
    pepSyncStatus: text('pep_sync_status').$type<PepSyncStatus | null>(),
    pepSyncError: text('pep_sync_error'),
    // Self-referential FK: managed at DB level; no Drizzle reference to avoid circular type
    rescheduledToId: uuid('rescheduled_to_id'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdVia: text('created_via').$type<AppointmentCreatedVia>().notNull().default('manual'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_appointments_clinic_doctor_start')
      .on(t.clinicId, t.doctorId, t.startAt)
      .where(sql`${t.status} NOT IN ('cancelled_by_patient','cancelled_by_clinic')`),
    index('idx_appointments_clinic_patient_start')
      .on(t.clinicId, t.patientId, t.startAt)
      .where(sql`${t.patientId} IS NOT NULL`),
    index('idx_appointments_clinic_status_start').on(t.clinicId, t.status, t.startAt),
    index('idx_appointments_clinic_upcoming').on(t.clinicId, t.startAt),
    uniqueIndex('idx_appointments_clinic_calcom_booking')
      .on(t.clinicId, t.calcomBookingId)
      .where(sql`${t.calcomBookingId} IS NOT NULL`),
    index('idx_appointments_clinic_pep_sync')
      .on(t.clinicId, t.pepSyncStatus)
      .where(sql`${t.pepSyncStatus} IN ('pending','failed')`),
    check(
      'appointments_status_check',
      sql`${t.status} IN ('scheduled','confirmed','in_progress','completed','no_show','cancelled_by_patient','cancelled_by_clinic','rescheduled')`,
    ),
    check('appointments_end_after_start', sql`${t.endAt} > ${t.startAt}`),
    check(
      'appointments_type_check',
      sql`${t.type} IN ('consultation','follow_up','procedure','exam','other')`,
    ),
    check(
      'appointments_modality_check',
      sql`${t.modality} IN ('in_person','telemedicine')`,
    ),
    check(
      'appointments_payment_status_check',
      sql`${t.paymentStatus} IN ('pending','paid','partial','refunded','waived')`,
    ),
    check(
      'appointments_created_via_check',
      sql`${t.createdVia} IN ('manual','whatsapp','website','calcom_external','pep_sync')`,
    ),
    check(
      'appointments_pep_sync_status_check',
      sql`${t.pepSyncStatus} IS NULL OR ${t.pepSyncStatus} IN ('pending','synced','failed')`,
    ),
  ],
);

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;

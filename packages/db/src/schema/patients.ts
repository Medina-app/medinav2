import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  customType,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { clinics } from './clinics.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const patients = pgTable(
  'patients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    preferredName: text('preferred_name'),
    phone: text('phone').notNull(),
    email: text('email'),
    birthDate: date('birth_date'),
    gender: text('gender'),
    encryptedCpf: bytea('encrypted_cpf'),
    cpfHash: text('cpf_hash'),
    address: jsonb('address'),
    emergencyContact: jsonb('emergency_contact'),
    medicalNotes: text('medical_notes'),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    metadata: jsonb('metadata').notNull().default({}),
    source: text('source'),
    createdBy: uuid('created_by'),
    lastContactAt: timestamp('last_contact_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_patients_clinic_name')
      .on(t.clinicId, t.fullName)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('idx_patients_clinic_phone_unique')
      .on(t.clinicId, t.phone)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('idx_patients_clinic_cpf_hash_unique')
      .on(t.clinicId, t.cpfHash)
      .where(sql`${t.deletedAt} IS NULL AND ${t.cpfHash} IS NOT NULL`),
    index('idx_patients_clinic_created_at')
      .on(t.clinicId, t.createdAt)
      .where(sql`${t.deletedAt} IS NULL`),
    check(
      'patients_full_name_length_check',
      sql`char_length(${t.fullName}) BETWEEN 1 AND 200`,
    ),
    check(
      'patients_phone_e164_check',
      sql`${t.phone} ~ '^\+[1-9]\d{7,14}$'`,
    ),
    check(
      'patients_gender_check',
      sql`${t.gender} IN ('male','female','other','prefer_not_say')`,
    ),
    check(
      'patients_source_check',
      sql`${t.source} IN ('whatsapp','manual','imported','website')`,
    ),
  ],
);

export type Patient = typeof patients.$inferSelect;
export type NewPatient = typeof patients.$inferInsert;

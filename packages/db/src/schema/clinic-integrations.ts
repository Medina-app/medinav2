import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
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

export const clinicIntegrations = pgTable(
  'clinic_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinics.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('configuring'),
    config: jsonb('config').notNull().default({}),
    encryptedCredentials: bytea('encrypted_credentials'),
    webhookSecret: text('webhook_secret'),
    webhookPath: text('webhook_path'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_clinic_integrations_clinic_status')
      .on(t.clinicId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index('idx_clinic_integrations_clinic_type_provider')
      .on(t.clinicId, t.type, t.provider)
      .where(sql`${t.deletedAt} IS NULL`),
    check(
      'clinic_integrations_type_check',
      sql`${t.type} IN ('pep','whatsapp','kapso','calcom','custom')`,
    ),
    check(
      'clinic_integrations_status_check',
      sql`${t.status} IN ('configuring','active','error','disabled')`,
    ),
  ],
);

export type ClinicIntegration = typeof clinicIntegrations.$inferSelect;
export type NewClinicIntegration = typeof clinicIntegrations.$inferInsert;

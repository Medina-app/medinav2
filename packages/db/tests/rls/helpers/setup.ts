import postgres from 'postgres';
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../../../apps/web/.env.local') });

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL not set in apps/web/.env.local');

export const TEST_ENCRYPTION_KEY = 'test-encryption-key-medina-2025';

export function getServiceClient(): postgres.Sql {
  return postgres(DATABASE_URL!, { max: 3 });
}

export async function createTestClinic(
  sql: postgres.Sql,
  name: string,
): Promise<{ id: string; name: string; slug: string }> {
  const slug = `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
  const rows = await sql<{ id: string; name: string; slug: string }[]>`
    INSERT INTO clinics (name, slug)
    VALUES (${name}, ${slug})
    RETURNING id, name, slug
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestClinic: no row returned');
  return row;
}

export async function createTestUser(
  sql: postgres.Sql,
): Promise<{ id: string; email: string }> {
  const id = crypto.randomUUID();
  const email = `test-${id}@medina-test.internal`;
  await sql`
    INSERT INTO auth.users (
      id, instance_id, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      aud, role, raw_app_meta_data, raw_user_meta_data, is_super_admin
    ) VALUES (
      ${id},
      '00000000-0000-0000-0000-000000000000',
      ${email},
      '',
      NOW(), NOW(), NOW(),
      'authenticated', 'authenticated',
      '{"provider":"email","providers":["email"]}',
      '{}',
      false
    )
  `;
  return { id, email };
}

export async function addUserToClinic(
  sql: postgres.Sql,
  clinicId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member' = 'member',
): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO clinic_members (clinic_id, user_id, role)
    VALUES (${clinicId}, ${userId}, ${role})
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('addUserToClinic: no row returned');
  return row;
}

/**
 * Creates a test integration via service role (bypasses RLS).
 * Encrypts the given credentials with TEST_ENCRYPTION_KEY.
 */
export async function createTestIntegration(
  sql: postgres.Sql,
  clinicId: string,
  opts: {
    type?: string;
    provider?: string;
    name?: string;
    plainCredentials?: string;
  } = {},
): Promise<{ id: string; clinic_id: string; webhook_path: string }> {
  const type = opts.type ?? 'whatsapp';
  const provider = opts.provider ?? 'cloud_api';
  const name = opts.name ?? `Test ${type} ${Date.now()}`;
  const plainCredentials = opts.plainCredentials ?? '{"token":"test-secret-123"}';

  const rows = await sql<{ id: string; clinic_id: string; webhook_path: string }[]>`
    INSERT INTO clinic_integrations (clinic_id, type, provider, name, encrypted_credentials)
    VALUES (
      ${clinicId},
      ${type},
      ${provider},
      ${name},
      encrypt_credential(${plainCredentials}, ${TEST_ENCRYPTION_KEY})
    )
    RETURNING id, clinic_id, webhook_path
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestIntegration: no row returned');
  return row;
}

export async function createTestPatient(
  sql: postgres.Sql,
  clinicId: string,
  opts: { phone?: string; fullName?: string } = {},
): Promise<{ id: string; clinic_id: string }> {
  const phone = opts.phone ?? `+5511${Date.now().toString().slice(-9)}`;
  const fullName = opts.fullName ?? `Patient ${Date.now()}`;
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO patients (clinic_id, full_name, phone)
    VALUES (${clinicId}, ${fullName}, ${phone})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestPatient: no row returned');
  return row;
}

/**
 * Returns a client that executes queries as the given user with RLS enforced.
 * Uses SET LOCAL inside a transaction so role + JWT claims are scoped to
 * that transaction only and do not leak between tests.
 */
export function getRlsClient(
  sql: postgres.Sql,
  userId: string,
): {
  query: <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => Promise<T>;
} {
  return {
    query: <T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
      sql.begin(async (tx) => {
        await tx`SET LOCAL role = 'authenticated'`;
        await tx`
          SELECT set_config(
            'request.jwt.claims',
            ${JSON.stringify({ sub: userId, role: 'authenticated' })},
            TRUE
          )
        `;
        return fn(tx);
      }) as Promise<T>,
  };
}

export async function createTestConversation(
  sql: postgres.Sql,
  clinicId: string,
  integrationId: string,
  opts: { externalId?: string } = {},
): Promise<{ id: string; clinic_id: string }> {
  const externalId = opts.externalId ?? `+5511${Date.now().toString().slice(-9)}`;
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO conversations (clinic_id, integration_id, channel, external_id)
    VALUES (${clinicId}, ${integrationId}, 'whatsapp', ${externalId})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestConversation: no row returned');
  return row;
}

export async function createTestMessage(
  sql: postgres.Sql,
  conversationId: string,
  clinicId: string,
  opts: { content?: string; direction?: string } = {},
): Promise<{ id: string }> {
  const content = opts.content ?? `msg-${Date.now()}`;
  const direction = opts.direction ?? 'inbound';
  const senderType = direction === 'inbound' ? 'patient' : 'ai';
  const rows = await sql<{ id: string }[]>`
    INSERT INTO messages (conversation_id, clinic_id, direction, sender_type, content_type, content)
    VALUES (${conversationId}, ${clinicId}, ${direction}, ${senderType}, 'text', ${content})
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestMessage: no row returned');
  return row;
}

export async function createTestPipeline(
  sql: postgres.Sql,
  clinicId: string,
  opts: { name?: string; isDefault?: boolean } = {},
): Promise<{ id: string; clinic_id: string }> {
  const name = opts.name ?? `Pipeline ${Date.now()}`;
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO pipelines (clinic_id, name, is_default)
    VALUES (${clinicId}, ${name}, ${opts.isDefault ?? false})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestPipeline: no row returned');
  return row;
}

export async function createTestPipelineStage(
  sql: postgres.Sql,
  clinicId: string,
  pipelineId: string,
  opts: { name?: string; position?: number; stageType?: string } = {},
): Promise<{ id: string; clinic_id: string }> {
  const name = opts.name ?? `Stage ${Date.now()}`;
  const position = opts.position ?? 0;
  const stageType = opts.stageType ?? 'open';
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO pipeline_stages (clinic_id, pipeline_id, name, position, stage_type)
    VALUES (${clinicId}, ${pipelineId}, ${name}, ${position}, ${stageType})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestPipelineStage: no row returned');
  return row;
}

export async function createTestDeal(
  sql: postgres.Sql,
  clinicId: string,
  pipelineId: string,
  stageId: string,
  opts: { title?: string; position?: number } = {},
): Promise<{ id: string; clinic_id: string }> {
  const title = opts.title ?? `Deal ${Date.now()}`;
  const position = opts.position ?? 0;
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO deals (clinic_id, pipeline_id, stage_id, title, position)
    VALUES (${clinicId}, ${pipelineId}, ${stageId}, ${title}, ${position})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestDeal: no row returned');
  return row;
}

export async function createTestDoctor(
  sql: postgres.Sql,
  clinicId: string,
  opts: { fullName?: string } = {},
): Promise<{ id: string; clinic_id: string }> {
  const fullName = opts.fullName ?? `Doctor ${Date.now()}`;
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO doctors (clinic_id, full_name)
    VALUES (${clinicId}, ${fullName})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestDoctor: no row returned');
  return row;
}

export async function createTestAppointment(
  sql: postgres.Sql,
  clinicId: string,
  doctorId: string,
  opts: {
    patientId?: string | null;
    conversationId?: string | null;
    dealId?: string | null;
    status?: string;
    startAt?: string;
    endAt?: string;
  } = {},
): Promise<{ id: string; clinic_id: string }> {
  const startAt = opts.startAt ?? new Date(Date.now() + 86400000).toISOString();
  const endAt = opts.endAt ?? new Date(Date.now() + 86400000 + 3600000).toISOString();
  const status = opts.status ?? 'scheduled';
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO appointments (clinic_id, doctor_id, status, start_at, end_at, patient_id, conversation_id, deal_id)
    VALUES (
      ${clinicId}, ${doctorId}, ${status}, ${startAt}, ${endAt},
      ${opts.patientId ?? null}, ${opts.conversationId ?? null}, ${opts.dealId ?? null}
    )
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestAppointment: no row returned');
  return row;
}

export async function cleanupAll(sql: postgres.Sql): Promise<void> {
  // Tables may not exist yet during TDD RED phase — suppress "relation does not exist".
  await sql`DELETE FROM appointment_reminders`.catch(() => null);
  await sql`DELETE FROM appointments`.catch(() => null);
  await sql`DELETE FROM doctors`.catch(() => null);
  await sql`DELETE FROM deals`.catch(() => null);
  await sql`DELETE FROM pipeline_stages`.catch(() => null);
  await sql`DELETE FROM pipelines`.catch(() => null);
  await sql`DELETE FROM messages`.catch(() => null);
  await sql`DELETE FROM conversations`.catch(() => null);
  // Two-step: mark as deleted (fires audit trigger), then actually delete.
  // The trigger only fires WHEN (OLD.deleted_at IS NULL), so the second DELETE is safe.
  await sql`UPDATE patients SET deleted_at = NOW() WHERE deleted_at IS NULL`;
  await sql`DELETE FROM patients`;
  await sql`UPDATE clinic_integrations SET deleted_at = NOW() WHERE deleted_at IS NULL`;
  await sql`DELETE FROM clinic_integrations`;
  // Delete audit_logs AFTER integrations: the soft-delete UPDATE above fires the audit
  // trigger and creates new rows; deleting audit_logs first would leave orphans that
  // block the clinics DELETE via FK constraint.
  await sql`DELETE FROM audit_logs`;
  await sql`DELETE FROM clinic_members`;
  await sql`DELETE FROM clinics`;
  await sql`DELETE FROM auth.users WHERE email LIKE '%@medina-test.internal'`;
}

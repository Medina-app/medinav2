import postgres from 'postgres';
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../../../apps/web/.env.local') });

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL not set in apps/web/.env.local');

export { TEST_VAULT_KEY, ensureVaultMasterKey, getVaultMasterKey } from './vault-bootstrap.js';

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
 * Encrypts the given credentials using the master key from supabase_vault —
 * caller must have run ensureVaultMasterKey() in beforeAll.
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
      encrypt_credential(${plainCredentials})
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

export async function createTestAgentConfig(
  sql: postgres.Sql,
  clinicId: string,
  opts: {
    name?: string;
    status?: string;
    systemPrompt?: string;
    model?: string;
  } = {},
): Promise<{ id: string; clinic_id: string; name: string; version: number; status: string }> {
  const name = opts.name ?? `agent-${Date.now()}`;
  const status = opts.status ?? 'draft';
  const systemPrompt = opts.systemPrompt ?? 'You are a helpful assistant.';
  const model = opts.model ?? 'claude-haiku-4-5';
  const rows = await sql<
    { id: string; clinic_id: string; name: string; version: number; status: string }[]
  >`
    INSERT INTO agent_configs (clinic_id, name, status, system_prompt, model)
    VALUES (${clinicId}, ${name}, ${status}, ${systemPrompt}, ${model})
    RETURNING id, clinic_id, name, version, status
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestAgentConfig: no row returned');
  return row;
}

export async function createTestKnowledgeDocument(
  sql: postgres.Sql,
  clinicId: string,
  opts: { title?: string; sourceType?: string; approvalStatus?: string } = {},
): Promise<{ id: string; clinic_id: string }> {
  const title = opts.title ?? `Doc ${Date.now()}`;
  const sourceType = opts.sourceType ?? 'manual';
  // AI-3.5b: default 'approved' pra back-compat com testes que assumem
  // chunks visíveis pela RPC search_knowledge_chunks_internal (que filtra
  // approval_status='approved'). Testes que precisam validar o workflow
  // de approval passam approvalStatus explicitamente.
  const approvalStatus = opts.approvalStatus ?? 'approved';
  const rows = await sql<{ id: string; clinic_id: string }[]>`
    INSERT INTO knowledge_documents (clinic_id, title, source_type, approval_status)
    VALUES (${clinicId}, ${title}, ${sourceType}, ${approvalStatus})
    RETURNING id, clinic_id
  `;
  const row = rows[0];
  if (!row) throw new Error('createTestKnowledgeDocument: no row returned');
  return row;
}

/**
 * Deletes ONLY the rows tied to a single clinic (and the clinic itself).
 * Use in afterAll to clean up exactly what the test created — never touches
 * other clinics' data, so dev fixtures and other test runs survive.
 *
 * Order matters: deepest children first, parent last. Each step is best-effort
 * with try/catch so a partial leak from a crashed test doesn't cascade-block
 * subsequent runs.
 */
export async function deleteTestClinic(sql: postgres.Sql, clinicId: string): Promise<void> {
  const tryStep = async (label: string, op: () => Promise<unknown>): Promise<void> => {
    try {
      await op();
    } catch (e) {
      // Swallow "relation does not exist" during TDD on tables not yet created.
      // Real FK errors will surface on later runs when tests recreate the same row.
      console.warn(`deleteTestClinic[${clinicId}/${label}]: ${(e as Error).message}`);
    }
  };

  await tryStep('appointment_reminders', () => sql`DELETE FROM appointment_reminders WHERE clinic_id = ${clinicId}`);
  await tryStep('appointments', () => sql`DELETE FROM appointments WHERE clinic_id = ${clinicId}`);
  await tryStep('doctors', () => sql`DELETE FROM doctors WHERE clinic_id = ${clinicId}`);
  await tryStep('deals', () => sql`DELETE FROM deals WHERE clinic_id = ${clinicId}`);
  await tryStep('pipeline_stages', () => sql`DELETE FROM pipeline_stages WHERE clinic_id = ${clinicId}`);
  await tryStep('pipelines', () => sql`DELETE FROM pipelines WHERE clinic_id = ${clinicId}`);
  await tryStep('messages', () => sql`DELETE FROM messages WHERE clinic_id = ${clinicId}`);
  await tryStep('conversations', () => sql`DELETE FROM conversations WHERE clinic_id = ${clinicId}`);
  await tryStep('knowledge_chunks', () => sql`DELETE FROM knowledge_chunks WHERE clinic_id = ${clinicId}`);
  await tryStep('knowledge_documents', () => sql`DELETE FROM knowledge_documents WHERE clinic_id = ${clinicId}`);
  await tryStep('agent_configs', () => sql`DELETE FROM agent_configs WHERE clinic_id = ${clinicId}`);

  // patients + clinic_integrations have soft-delete audit triggers that only
  // fire WHEN (OLD.deleted_at IS NULL). UPDATE first to fire the trigger
  // cleanly, then hard-DELETE.
  await tryStep('patients:soft', () =>
    sql`UPDATE patients SET deleted_at = NOW() WHERE clinic_id = ${clinicId} AND deleted_at IS NULL`,
  );
  await tryStep('patients', () => sql`DELETE FROM patients WHERE clinic_id = ${clinicId}`);
  await tryStep('clinic_integrations:soft', () =>
    sql`UPDATE clinic_integrations SET deleted_at = NOW() WHERE clinic_id = ${clinicId} AND deleted_at IS NULL`,
  );
  await tryStep('clinic_integrations', () => sql`DELETE FROM clinic_integrations WHERE clinic_id = ${clinicId}`);

  // audit_logs after integrations: the soft-delete UPDATE above fires the
  // audit trigger and adds new rows; deleting audit_logs first would leave
  // orphans that block the clinics DELETE via FK.
  await tryStep('audit_logs', () => sql`DELETE FROM audit_logs WHERE clinic_id = ${clinicId}`);
  await tryStep('clinic_members', () => sql`DELETE FROM clinic_members WHERE clinic_id = ${clinicId}`);
  await tryStep('clinics', () => sql`DELETE FROM clinics WHERE id = ${clinicId}`);
}

/**
 * Deletes a single test auth.user. The email pattern is enforced by
 * createTestUser so we only ever target test-issued users.
 */
export async function deleteTestUser(sql: postgres.Sql, userId: string): Promise<void> {
  try {
    await sql`DELETE FROM auth.users WHERE id = ${userId} AND email LIKE '%@medina-test.internal'`;
  } catch (e) {
    console.warn(`deleteTestUser[${userId}]: ${(e as Error).message}`);
  }
}


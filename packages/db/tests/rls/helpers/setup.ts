import postgres from 'postgres';
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../../../apps/web/.env.local') });

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL not set in apps/web/.env.local');

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

export async function cleanupAll(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM audit_logs`;
  await sql`DELETE FROM clinic_members`;
  await sql`DELETE FROM clinics`;
  await sql`DELETE FROM auth.users WHERE email LIKE '%@medina-test.internal'`;
}

import type postgres from 'postgres';

export const TEST_VAULT_KEY = 'test-encryption-key-medina-2025';

const SECRET_NAME = 'medina_master_encryption_key';

/**
 * Idempotent: only creates the vault secret if missing. Never overwrites an
 * existing value — protects shared dev DBs where the prod master key may already
 * be bootstrapped. In a fresh CI/test DB, seeds with TEST_VAULT_KEY so tests can
 * encrypt+decrypt round-trip.
 */
export async function ensureVaultMasterKey(
  sql: postgres.Sql,
  key: string = TEST_VAULT_KEY,
): Promise<void> {
  // DO blocks don't accept prepared-statement parameters, so we split into
  // SELECT-then-conditional-INSERT. Race condition between the two statements
  // is acceptable for test bootstrap (worst case: a duplicate-name error,
  // which would surface clearly if it ever happened).
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM vault.secrets WHERE name = ${SECRET_NAME}
  `;
  if (existing.length === 0) {
    await sql`
      SELECT vault.create_secret(${key}::text, ${SECRET_NAME}::text, 'test bootstrap'::text)
    `;
  }
}

export async function getVaultMasterKey(sql: postgres.Sql): Promise<string | null> {
  const rows = await sql<{ decrypted_secret: string | null }[]>`
    SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ${SECRET_NAME}
  `;
  return rows[0]?.decrypted_secret ?? null;
}

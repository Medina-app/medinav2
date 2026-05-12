import { Buffer } from 'node:buffer';
import type { ClinicIntegration } from '@medina/db';

/**
 * Supabase JS returns rows with raw Postgres column names (snake_case).
 * The Drizzle ClinicIntegration type uses camelCase. Without this mapper,
 * accessing `integration.webhookSecret` (camel) on a raw row silently
 * returns `undefined` — observed as a 403 `secret_not_configured` even when
 * the column was populated.
 *
 * Call this on the boundary (LookupFn implementations) so the rest of the
 * handler + adapters can trust the camelCase ClinicIntegration shape.
 */
export function mapClinicIntegration(row: Record<string, unknown>): ClinicIntegration {
  const dt = (v: unknown): Date | null => (v ? new Date(v as string) : null);

  return {
    id: row['id'] as string,
    clinicId: row['clinic_id'] as string,
    type: row['type'] as string,
    provider: row['provider'] as string,
    name: row['name'] as string,
    status: row['status'] as string,
    config: (row['config'] as ClinicIntegration['config']) ?? {},
    // PR-E #8: Supabase JS serializa bytea como hex string (`\x...`), não Buffer.
    // Drizzle ORM client (não usado nessa boundary hoje) sim retorna Buffer.
    // Validamos runtime — sem Buffer real, retornamos null. Quem precisa dos
    // bytes decifrados usa get_integration_credential_internal RPC server-side.
    encryptedCredentials: Buffer.isBuffer(row['encrypted_credentials'])
      ? row['encrypted_credentials']
      : null,
    webhookSecret: (row['webhook_secret'] as string | null) ?? null,
    webhookPath: row['webhook_path'] as string,
    lastSyncAt: dt(row['last_sync_at']),
    lastError: (row['last_error'] as string | null) ?? null,
    lastErrorAt: dt(row['last_error_at']),
    metadata: (row['metadata'] as ClinicIntegration['metadata']) ?? {},
    deletedAt: dt(row['deleted_at']),
    createdAt: new Date(row['created_at'] as string) as ClinicIntegration['createdAt'],
    updatedAt: new Date(row['updated_at'] as string) as ClinicIntegration['updatedAt'],
  };
}

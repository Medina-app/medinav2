import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic,
  createTestClinic,
  createTestIntegration,
  createTestUser,
  deleteTestClinic,
  ensureVaultMasterKey,
  getRlsClient,
  getServiceClient,
} from './helpers/setup.js';

const sql = getServiceClient();
const createdClinics: string[] = [];
async function makeClinic(name: string) {
  const c = await createTestClinic(sql, name);
  createdClinics.push(c.id);
  return c;
}

beforeAll(async () => {
  await ensureVaultMasterKey(sql);
});

afterAll(async () => {
  await Promise.all(createdClinics.map((id) => deleteTestClinic(sql, id)));
  await sql.end();
});

// ─── Cross-tenant isolation ───────────────────────────────────────────────────

describe('clinic_integrations: cross-tenant isolation', () => {
  it('users only see integrations of their own clinic', async () => {
    const clinicA = await makeClinic('Integrations Tenant A');
    const clinicB = await makeClinic('Integrations Tenant B');
    const userA = await createTestUser(sql);
    await addUserToClinic(sql, clinicA.id, userA.id, 'member');

    const intA = await createTestIntegration(sql, clinicA.id, { name: 'WA Clinic A' });
    const intB = await createTestIntegration(sql, clinicB.id, { name: 'WA Clinic B' });

    const client = getRlsClient(sql, userA.id);
    const rows = await client.query((tx) =>
      tx<{ id: string }[]>`SELECT id FROM clinic_integrations WHERE deleted_at IS NULL`,
    );

    const ids = rows.map((r) => r.id);
    expect(ids).toContain(intA.id);
    expect(ids).not.toContain(intB.id);
  });
});

// ─── RBAC: INSERT ─────────────────────────────────────────────────────────────

describe('clinic_integrations: RBAC insert', () => {
  it('non-admin (member) cannot insert integration', async () => {
    const clinic = await makeClinic('RBAC Insert Member');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    const client = getRlsClient(sql, member.id);
    await expect(
      client.query((tx) =>
        tx`
          INSERT INTO clinic_integrations (clinic_id, type, provider, name)
          VALUES (${clinic.id}, 'whatsapp', 'cloud_api', 'Member Insert Attempt')
        `,
      ),
    ).rejects.toThrow();
  });

  it('admin can insert integration', async () => {
    const clinic = await makeClinic('RBAC Insert Admin');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');

    const client = getRlsClient(sql, admin.id);
    await expect(
      client.query((tx) =>
        tx<{ id: string }[]>`
          INSERT INTO clinic_integrations (clinic_id, type, provider, name)
          VALUES (${clinic.id}, 'calcom', 'cal', 'Admin Insert Cal')
          RETURNING id
        `,
      ),
    ).resolves.not.toThrow();
  });
});

// ─── RBAC: UPDATE ─────────────────────────────────────────────────────────────

describe('clinic_integrations: RBAC update', () => {
  it('non-admin (member) cannot update integration (0 rows affected)', async () => {
    const clinic = await makeClinic('RBAC Update Block');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    const integration = await createTestIntegration(sql, clinic.id, { name: 'WA Update Block' });

    const client = getRlsClient(sql, member.id);
    const result = await client.query((tx) =>
      tx<{ id: string }[]>`
        UPDATE clinic_integrations
        SET name = 'Hacked'
        WHERE id = ${integration.id}
        RETURNING id
      `,
    );
    expect(result).toHaveLength(0);
  });
});

// ─── Encrypted credentials ────────────────────────────────────────────────────

describe('clinic_integrations: encrypted_credentials', () => {
  it('encrypted_credentials is returned as bytea (Buffer), not plain text', async () => {
    const clinic = await makeClinic('Encrypt Bytea');
    const integration = await createTestIntegration(sql, clinic.id, {
      plainCredentials: '{"api_key":"super-secret-value"}',
    });

    const rows = await sql<{ encrypted_credentials: Buffer | null }[]>`
      SELECT encrypted_credentials
      FROM clinic_integrations
      WHERE id = ${integration.id}
    `;
    const cred = rows[0]?.encrypted_credentials;

    expect(cred).toBeInstanceOf(Buffer);
    expect(cred!.toString('utf-8')).not.toContain('super-secret-value');
  });

  it('admin can decrypt credentials via get_integration_credential', async () => {
    const clinic = await makeClinic('Decrypt Admin');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');

    const plainCredentials = '{"token":"admin-decrypt-ok"}';
    const integration = await createTestIntegration(sql, clinic.id, { plainCredentials });

    const client = getRlsClient(sql, admin.id);
    const rows = await client.query((tx) =>
      tx<{ val: string }[]>`
        SELECT get_integration_credential(${integration.id}::uuid) AS val
      `,
    );

    expect(rows[0]?.val).toBe(plainCredentials);
  });

  it('non-admin (member) cannot decrypt via get_integration_credential', async () => {
    const clinic = await makeClinic('Decrypt Member Block');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');

    const integration = await createTestIntegration(sql, clinic.id);

    const client = getRlsClient(sql, member.id);
    await expect(
      client.query((tx) =>
        tx<{ val: string }[]>`
          SELECT get_integration_credential(${integration.id}::uuid) AS val
        `,
      ),
    ).rejects.toThrow('access denied');
  });

  // ── 0015: service_role-only variant for Inngest worker ──────────────────────

  it('service_role decrypts via get_integration_credential_internal (worker path)', async () => {
    const clinic = await makeClinic('Decrypt Internal Worker');
    const plainCredentials = '{"api_key":"worker-decrypt-ok"}';
    const integration = await createTestIntegration(sql, clinic.id, { plainCredentials });

    // sql is the service-role client — same authority as the Inngest worker
    // makeAdminSupabase(). Role check is bypassed by design (worker has no
    // authenticated user context).
    const rows = await sql<{ val: string }[]>`
      SELECT get_integration_credential_internal(${integration.id}::uuid) AS val
    `;

    expect(rows[0]?.val).toBe(plainCredentials);
  });

  it('authenticated user denied on get_integration_credential_internal (grant revoked)', async () => {
    const clinic = await makeClinic('Decrypt Internal Denied');
    const admin = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');
    const integration = await createTestIntegration(sql, clinic.id);

    // Even an admin authenticated user is denied — the function REVOKEs from
    // anon + authenticated and only GRANTs to service_role. The denial comes
    // from the GRANT layer (SQLSTATE 42501), not from a runtime role check.
    const client = getRlsClient(sql, admin.id);
    await expect(
      client.query((tx) =>
        tx<{ val: string }[]>`
          SELECT get_integration_credential_internal(${integration.id}::uuid) AS val
        `,
      ),
    ).rejects.toThrow(/permission denied for function get_integration_credential_internal/);
  });
});

// ─── Audit log ────────────────────────────────────────────────────────────────

describe('clinic_integrations: automatic audit log', () => {
  it('INSERT creates an audit log entry with action integration.created', async () => {
    const clinic = await makeClinic('Audit Integration');

    const before = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM audit_logs WHERE clinic_id = ${clinic.id}
    `;
    const countBefore = Number(before[0]?.count ?? 0);

    await createTestIntegration(sql, clinic.id, { name: 'Audit WA' });

    const rows = await sql<{ action: string; resource: string }[]>`
      SELECT action, resource
      FROM audit_logs
      WHERE clinic_id = ${clinic.id}
        AND action = 'integration.created'
    `;

    expect(rows.length).toBeGreaterThan(countBefore);
    expect(rows[0]?.resource).toBe('clinic_integrations');
  });
});

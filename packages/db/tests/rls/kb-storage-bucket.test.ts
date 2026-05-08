import { describe, it, expect, afterAll } from 'vitest';
import {
  getServiceClient,
  createTestClinic,
  createTestUser,
  addUserToClinic,
  getRlsClient,
  deleteTestClinic,
  deleteTestUser,
} from './helpers/setup.js';

const sql = getServiceClient();
const createdClinicIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  // Cleanup storage objects criados pelos testes (admin/owner clinic).
  for (const id of createdClinicIds) {
    try {
      await sql`DELETE FROM storage.objects WHERE bucket_id = 'kb-uploads' AND name LIKE ${id + '/%'}`;
    } catch {
      /* swallow */
    }
  }
  await Promise.all(createdClinicIds.map((id) => deleteTestClinic(sql, id)));
  await Promise.all(createdUserIds.map((id) => deleteTestUser(sql, id)));
  await sql.end();
});

async function makeClinic(name: string): Promise<{ id: string }> {
  const c = await createTestClinic(sql, name);
  createdClinicIds.push(c.id);
  return c;
}

async function makeUser(): Promise<{ id: string; email: string }> {
  const u = await createTestUser(sql);
  createdUserIds.push(u.id);
  return u;
}

describe('AI-3.5b: kb-uploads storage bucket + RLS', () => {
  it('1. bucket existe, privado, 5MB cap, mime types restritos', async () => {
    const [bucket] = await sql<
      {
        id: string;
        public: boolean;
        file_size_limit: number;
        allowed_mime_types: string[];
      }[]
    >`
      SELECT id, public, file_size_limit, allowed_mime_types
      FROM storage.buckets
      WHERE id = 'kb-uploads'
    `;
    expect(bucket).toBeDefined();
    expect(bucket?.public).toBe(false);
    // postgres-js serializa bigint como string (preserva precisão arbitrária);
    // cast pra number antes de comparar com literal numeric.
    expect(Number(bucket?.file_size_limit)).toBe(5 * 1024 * 1024);
    expect(bucket?.allowed_mime_types).toContain('text/markdown');
    expect(bucket?.allowed_mime_types).toContain('text/plain');
  });

  it('2. admin/owner pode INSERT objeto em path da própria clinic', async () => {
    const c = await makeClinic('KbStorage-Admin');
    const user = await makeUser();
    await addUserToClinic(sql, c.id, user.id, 'admin');

    const rls = getRlsClient(sql, user.id);
    const path = `${c.id}/test-doc-${Date.now()}.md`;

    await expect(
      rls.query(
        (tx) => tx`
          INSERT INTO storage.objects (bucket_id, name, owner)
          VALUES ('kb-uploads', ${path}, ${user.id})
        `,
      ),
    ).resolves.toBeDefined();
  });

  it('3. cross-tenant: admin clinic A NÃO consegue INSERT em path clinic B', async () => {
    const clinicA = await makeClinic('KbStorage-CrossA');
    const clinicB = await makeClinic('KbStorage-CrossB');
    const userA = await makeUser();
    await addUserToClinic(sql, clinicA.id, userA.id, 'admin');

    const rls = getRlsClient(sql, userA.id);
    const malicious = `${clinicB.id}/leak-${Date.now()}.md`;

    await expect(
      rls.query(
        (tx) => tx`
          INSERT INTO storage.objects (bucket_id, name, owner)
          VALUES ('kb-uploads', ${malicious}, ${userA.id})
        `,
      ),
    ).rejects.toThrow(/row-level security|policy|new row violates/i);
  });

  it('4. members podem SELECT objeto em path da própria clinic (download)', async () => {
    const c = await makeClinic('KbStorage-MemberRead');
    const adminUser = await makeUser();
    const memberUser = await makeUser();
    await addUserToClinic(sql, c.id, adminUser.id, 'admin');
    await addUserToClinic(sql, c.id, memberUser.id, 'member');

    // Admin insere objeto.
    const path = `${c.id}/member-test-${Date.now()}.md`;
    const adminRls = getRlsClient(sql, adminUser.id);
    await adminRls.query(
      (tx) => tx`
        INSERT INTO storage.objects (bucket_id, name, owner)
        VALUES ('kb-uploads', ${path}, ${adminUser.id})
      `,
    );

    // Member SELECT.
    const memberRls = getRlsClient(sql, memberUser.id);
    const rows = await memberRls.query(
      (tx) => tx<{ name: string }[]>`
        SELECT name FROM storage.objects
        WHERE bucket_id = 'kb-uploads' AND name = ${path}
      `,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe(path);
  });

  it('5. cross-tenant SELECT: member clinic A NÃO vê objeto em path clinic B', async () => {
    const clinicA = await makeClinic('KbStorage-MemberCrossA');
    const clinicB = await makeClinic('KbStorage-MemberCrossB');
    const memberA = await makeUser();
    const adminB = await makeUser();
    await addUserToClinic(sql, clinicA.id, memberA.id, 'member');
    await addUserToClinic(sql, clinicB.id, adminB.id, 'admin');

    // Admin clinic B cria objeto.
    const pathB = `${clinicB.id}/secret-${Date.now()}.md`;
    const adminBRls = getRlsClient(sql, adminB.id);
    await adminBRls.query(
      (tx) => tx`
        INSERT INTO storage.objects (bucket_id, name, owner)
        VALUES ('kb-uploads', ${pathB}, ${adminB.id})
      `,
    );

    // Member A tenta listar — deve retornar zero rows pra path clinic B.
    const memberARls = getRlsClient(sql, memberA.id);
    const rows = await memberARls.query(
      (tx) => tx<{ name: string }[]>`
        SELECT name FROM storage.objects
        WHERE bucket_id = 'kb-uploads' AND name = ${pathB}
      `,
    );
    expect(rows.length).toBe(0);
  });
});

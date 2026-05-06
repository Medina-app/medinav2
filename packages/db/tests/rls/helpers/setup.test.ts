import { afterAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic,
  createTestAgentConfig,
  createTestClinic,
  createTestConversation,
  createTestIntegration,
  createTestPatient,
  createTestUser,
  deleteTestClinic,
  deleteTestUser,
  ensureVaultMasterKey,
  getServiceClient,
} from './setup.js';

const sql = getServiceClient();
const createdClinics: string[] = [];
const createdUsers: string[] = [];

afterAll(async () => {
  await Promise.all(createdClinics.map((id) => deleteTestClinic(sql, id)));
  await Promise.all(createdUsers.map((id) => deleteTestUser(sql, id)));
  await sql.end();
});

// Regression for issue #5: deleteTestClinic must NOT touch other clinics'
// rows. Before the fix, cleanupAll did `DELETE FROM clinics` (no WHERE),
// which wiped every dev fixture on every test run.
describe('deleteTestClinic — surgical cleanup (issue #5)', () => {
  it('deletes ONLY the target clinic + its children, leaves siblings intact', async () => {
    await ensureVaultMasterKey(sql);

    const clinicA = await createTestClinic(sql, 'IsolationTarget A');
    createdClinics.push(clinicA.id);
    const clinicB = await createTestClinic(sql, 'IsolationGuard B');
    createdClinics.push(clinicB.id);

    // Populate both with the same shape of children so the test is symmetric.
    const userA = await createTestUser(sql);
    createdUsers.push(userA.id);
    await addUserToClinic(sql, clinicA.id, userA.id);
    const integrationA = await createTestIntegration(sql, clinicA.id);
    const patientA = await createTestPatient(sql, clinicA.id);
    const conversationA = await createTestConversation(sql, clinicA.id, integrationA.id);
    const agentA = await createTestAgentConfig(sql, clinicA.id);

    const userB = await createTestUser(sql);
    createdUsers.push(userB.id);
    await addUserToClinic(sql, clinicB.id, userB.id);
    const integrationB = await createTestIntegration(sql, clinicB.id);
    const patientB = await createTestPatient(sql, clinicB.id);
    const conversationB = await createTestConversation(sql, clinicB.id, integrationB.id);
    const agentB = await createTestAgentConfig(sql, clinicB.id);

    // Sanity: both halves of the fixture exist.
    const before = await sql<{ table_name: string; n: number }[]>`
      SELECT 'clinics' AS table_name, count(*)::int AS n FROM clinics WHERE id IN (${clinicA.id}, ${clinicB.id})
      UNION ALL
      SELECT 'integrations', count(*)::int FROM clinic_integrations WHERE clinic_id IN (${clinicA.id}, ${clinicB.id})
      UNION ALL
      SELECT 'patients', count(*)::int FROM patients WHERE clinic_id IN (${clinicA.id}, ${clinicB.id})
      UNION ALL
      SELECT 'conversations', count(*)::int FROM conversations WHERE clinic_id IN (${clinicA.id}, ${clinicB.id})
      UNION ALL
      SELECT 'agent_configs', count(*)::int FROM agent_configs WHERE clinic_id IN (${clinicA.id}, ${clinicB.id})
    `;
    for (const row of before) {
      expect(row.n, `setup ${row.table_name}`).toBe(2);
    }

    // Act: delete ONLY clinic A.
    await deleteTestClinic(sql, clinicA.id);

    // Clinic A and all its children must be gone.
    const aGone = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM clinics WHERE id = ${clinicA.id}`;
    expect(aGone[0]?.n, 'clinicA gone').toBe(0);

    const aIntGone = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM clinic_integrations WHERE id = ${integrationA.id}
    `;
    expect(aIntGone[0]?.n, 'integrationA gone').toBe(0);

    const aPatGone = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM patients WHERE id = ${patientA.id}`;
    expect(aPatGone[0]?.n, 'patientA gone').toBe(0);

    const aConvGone = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conversations WHERE id = ${conversationA.id}
    `;
    expect(aConvGone[0]?.n, 'conversationA gone').toBe(0);

    const aAgentGone = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agent_configs WHERE id = ${agentA.id}`;
    expect(aAgentGone[0]?.n, 'agentA gone').toBe(0);

    // Clinic B and all its children must STILL exist — this is the regression
    // guard. If anyone replaces deleteTestClinic with a "DELETE FROM X" again,
    // these expectations will catch it.
    const bAlive = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM clinics WHERE id = ${clinicB.id}`;
    expect(bAlive[0]?.n, 'clinicB survived').toBe(1);

    const bIntAlive = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM clinic_integrations WHERE id = ${integrationB.id}
    `;
    expect(bIntAlive[0]?.n, 'integrationB survived').toBe(1);

    const bPatAlive = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM patients WHERE id = ${patientB.id} AND deleted_at IS NULL
    `;
    expect(bPatAlive[0]?.n, 'patientB survived').toBe(1);

    const bConvAlive = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conversations WHERE id = ${conversationB.id}
    `;
    expect(bConvAlive[0]?.n, 'conversationB survived').toBe(1);

    const bAgentAlive = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM agent_configs WHERE id = ${agentB.id}
    `;
    expect(bAgentAlive[0]?.n, 'agentB survived').toBe(1);
  });
});

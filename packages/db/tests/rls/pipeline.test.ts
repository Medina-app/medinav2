import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToClinic,
  cleanupAll,
  createTestClinic,
  createTestConversation,
  createTestDeal,
  createTestIntegration,
  createTestPatient,
  createTestPipeline,
  createTestPipelineStage,
  createTestUser,
  getRlsClient,
  getServiceClient,
} from './helpers/setup.js';

const sql = getServiceClient();
beforeAll(async () => { await cleanupAll(sql); });
afterAll(async () => { await cleanupAll(sql); await sql.end(); });

describe('pipelines: cross-tenant isolation', () => {
  it('users only see pipelines/stages/deals of their clinics', async () => {
    const cA = await createTestClinic(sql, 'Pipe A');
    const cB = await createTestClinic(sql, 'Pipe B');
    const uA = await createTestUser(sql);
    await addUserToClinic(sql, cA.id, uA.id);

    const pA = await createTestPipeline(sql, cA.id);
    const sA = await createTestPipelineStage(sql, cA.id, pA.id);
    const dA = await createTestDeal(sql, cA.id, pA.id, sA.id);

    const pB = await createTestPipeline(sql, cB.id);
    const sB = await createTestPipelineStage(sql, cB.id, pB.id);
    await createTestDeal(sql, cB.id, pB.id, sB.id);

    const rls = getRlsClient(sql, uA.id);

    const pipes = await rls.query((tx) => tx<{ id: string }[]>`SELECT id FROM pipelines`);
    expect(pipes.map((r) => r.id)).toEqual([pA.id]);

    const stages = await rls.query((tx) => tx<{ id: string }[]>`SELECT id FROM pipeline_stages`);
    expect(stages.map((r) => r.id)).toEqual([sA.id]);

    const deals = await rls.query((tx) => tx<{ id: string }[]>`SELECT id FROM deals`);
    expect(deals.map((r) => r.id)).toEqual([dA.id]);
  });
});

describe('deals: create and update permissions', () => {
  it('member can create deal', async () => {
    const clinic = await createTestClinic(sql, 'Deal Create');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const pipeline = await createTestPipeline(sql, clinic.id);
    const stage = await createTestPipelineStage(sql, clinic.id, pipeline.id);

    const rows = await getRlsClient(sql, member.id).query((tx) =>
      tx<{ id: string }[]>`
        INSERT INTO deals (clinic_id, pipeline_id, stage_id, title, position)
        VALUES (${clinic.id}, ${pipeline.id}, ${stage.id}, 'New Deal', 0)
        RETURNING id
      `,
    );
    expect(rows[0]?.id).toBeDefined();
  });

  it('assigned member can update their own deal', async () => {
    const clinic = await createTestClinic(sql, 'Deal Update Assigned');
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const pipeline = await createTestPipeline(sql, clinic.id);
    const stage = await createTestPipelineStage(sql, clinic.id, pipeline.id);

    const deal = await sql<{ id: string }[]>`
      INSERT INTO deals (clinic_id, pipeline_id, stage_id, title, position, assigned_user_id)
      VALUES (${clinic.id}, ${pipeline.id}, ${stage.id}, 'Assigned Deal', 0, ${member.id})
      RETURNING id
    `;
    const dealId = deal[0]!.id;

    await expect(
      getRlsClient(sql, member.id).query((tx) =>
        tx`UPDATE deals SET title = 'Updated' WHERE id = ${dealId}`,
      ),
    ).resolves.toBeDefined();
  });

  it('non-assigned member cannot update another member deal', async () => {
    const clinic = await createTestClinic(sql, 'Deal Update Non-assigned');
    const owner = await createTestUser(sql);
    const outsider = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, owner.id, 'member');
    await addUserToClinic(sql, clinic.id, outsider.id, 'member');
    const pipeline = await createTestPipeline(sql, clinic.id);
    const stage = await createTestPipelineStage(sql, clinic.id, pipeline.id);

    const deal = await sql<{ id: string }[]>`
      INSERT INTO deals (clinic_id, pipeline_id, stage_id, title, position, assigned_user_id)
      VALUES (${clinic.id}, ${pipeline.id}, ${stage.id}, 'Owned Deal', 0, ${owner.id})
      RETURNING id
    `;
    const dealId = deal[0]!.id;

    const updated = await getRlsClient(sql, outsider.id).query((tx) =>
      tx<{ rowcount: number }[]>`
        UPDATE deals SET title = 'Hacked' WHERE id = ${dealId}
        RETURNING id
      `,
    );
    expect(updated).toHaveLength(0);
  });

  it('admin can update any deal in clinic', async () => {
    const clinic = await createTestClinic(sql, 'Deal Admin Update');
    const admin = await createTestUser(sql);
    const member = await createTestUser(sql);
    await addUserToClinic(sql, clinic.id, admin.id, 'admin');
    await addUserToClinic(sql, clinic.id, member.id, 'member');
    const pipeline = await createTestPipeline(sql, clinic.id);
    const stage = await createTestPipelineStage(sql, clinic.id, pipeline.id);
    const deal = await createTestDeal(sql, clinic.id, pipeline.id, stage.id);

    const rows = await getRlsClient(sql, admin.id).query((tx) =>
      tx<{ id: string }[]>`
        UPDATE deals SET title = 'Admin Updated' WHERE id = ${deal.id} RETURNING id
      `,
    );
    expect(rows[0]?.id).toBe(deal.id);
  });
});

describe('pipeline_stages: cross-tenant FK guard', () => {
  it('stage.clinic_id must match pipeline.clinic_id', async () => {
    const cA = await createTestClinic(sql, 'Stage FK A');
    const cB = await createTestClinic(sql, 'Stage FK B');
    const pA = await createTestPipeline(sql, cA.id);

    await expect(
      sql`
        INSERT INTO pipeline_stages (clinic_id, pipeline_id, name, position, stage_type)
        VALUES (${cB.id}, ${pA.id}, 'Bad Stage', 0, 'open')
      `,
    ).rejects.toThrow();
  });
});

describe('deals: cross-tenant FK guards', () => {
  it('deal.patient_id must match same clinic', async () => {
    const cA = await createTestClinic(sql, 'Deal Pat FK A');
    const cB = await createTestClinic(sql, 'Deal Pat FK B');
    const pA = await createTestPipeline(sql, cA.id);
    const sA = await createTestPipelineStage(sql, cA.id, pA.id);
    const patientB = await createTestPatient(sql, cB.id);

    await expect(
      sql`
        INSERT INTO deals (clinic_id, pipeline_id, stage_id, title, position, patient_id)
        VALUES (${cA.id}, ${pA.id}, ${sA.id}, 'Bad Deal', 0, ${patientB.id})
      `,
    ).rejects.toThrow();
  });

  it('deal.conversation_id must match same clinic', async () => {
    const cA = await createTestClinic(sql, 'Deal Conv FK A');
    const cB = await createTestClinic(sql, 'Deal Conv FK B');
    const pA = await createTestPipeline(sql, cA.id);
    const sA = await createTestPipelineStage(sql, cA.id, pA.id);
    const intB = await createTestIntegration(sql, cB.id);
    const convB = await createTestConversation(sql, cB.id, intB.id);

    await expect(
      sql`
        INSERT INTO deals (clinic_id, pipeline_id, stage_id, title, position, conversation_id)
        VALUES (${cA.id}, ${pA.id}, ${sA.id}, 'Bad Deal Conv', 0, ${convB.id})
      `,
    ).rejects.toThrow();
  });

  it('deal.stage_id must belong to the same clinic as deal.clinic_id', async () => {
    const cA = await createTestClinic(sql, 'Deal Stage FK A');
    const cB = await createTestClinic(sql, 'Deal Stage FK B');
    const pA = await createTestPipeline(sql, cA.id);
    const pB = await createTestPipeline(sql, cB.id);
    const sB = await createTestPipelineStage(sql, cB.id, pB.id);

    await expect(
      sql`
        INSERT INTO deals (clinic_id, pipeline_id, stage_id, title, position)
        VALUES (${cA.id}, ${pA.id}, ${sB.id}, 'Bad Stage Deal', 0)
      `,
    ).rejects.toThrow();
  });
});

describe('deals: moving between stages', () => {
  it('moving deal updates stage_id and position correctly', async () => {
    const clinic = await createTestClinic(sql, 'Move Deal');
    const pipeline = await createTestPipeline(sql, clinic.id);
    const stage1 = await createTestPipelineStage(sql, clinic.id, pipeline.id, { position: 0 });
    const stage2 = await createTestPipelineStage(sql, clinic.id, pipeline.id, { position: 1 });
    const deal = await createTestDeal(sql, clinic.id, pipeline.id, stage1.id, { position: 0 });

    await sql`
      UPDATE deals SET stage_id = ${stage2.id}, position = 2
      WHERE id = ${deal.id}
    `;

    const [updated] = await sql<{ stage_id: string; position: number }[]>`
      SELECT stage_id, position FROM deals WHERE id = ${deal.id}
    `;
    expect(updated?.stage_id).toBe(stage2.id);
    expect(updated?.position).toBe(2);
  });

  it('moving deal to won stage sets won_at', async () => {
    const clinic = await createTestClinic(sql, 'Won Stage');
    const pipeline = await createTestPipeline(sql, clinic.id);
    const openStage = await createTestPipelineStage(sql, clinic.id, pipeline.id, { stageType: 'open' });
    const wonStage = await createTestPipelineStage(sql, clinic.id, pipeline.id, { stageType: 'won', position: 1 });
    const deal = await createTestDeal(sql, clinic.id, pipeline.id, openStage.id);

    await sql`UPDATE deals SET stage_id = ${wonStage.id} WHERE id = ${deal.id}`;

    const [row] = await sql<{ won_at: string | null; lost_at: string | null }[]>`
      SELECT won_at, lost_at FROM deals WHERE id = ${deal.id}
    `;
    expect(row?.won_at).not.toBeNull();
    expect(row?.lost_at).toBeNull();
  });

  it('moving deal to lost stage sets lost_at', async () => {
    const clinic = await createTestClinic(sql, 'Lost Stage');
    const pipeline = await createTestPipeline(sql, clinic.id);
    const openStage = await createTestPipelineStage(sql, clinic.id, pipeline.id, { stageType: 'open' });
    const lostStage = await createTestPipelineStage(sql, clinic.id, pipeline.id, { stageType: 'lost', position: 1 });
    const deal = await createTestDeal(sql, clinic.id, pipeline.id, openStage.id);

    await sql`UPDATE deals SET stage_id = ${lostStage.id} WHERE id = ${deal.id}`;

    const [row] = await sql<{ won_at: string | null; lost_at: string | null }[]>`
      SELECT won_at, lost_at FROM deals WHERE id = ${deal.id}
    `;
    expect(row?.lost_at).not.toBeNull();
    expect(row?.won_at).toBeNull();
  });
});

describe('deals: audit log on stage move', () => {
  it('audit log entry is created when deal stage changes', async () => {
    const clinic = await createTestClinic(sql, 'Audit Move');
    const pipeline = await createTestPipeline(sql, clinic.id);
    const stage1 = await createTestPipelineStage(sql, clinic.id, pipeline.id, { position: 0 });
    const stage2 = await createTestPipelineStage(sql, clinic.id, pipeline.id, { position: 1 });
    const deal = await createTestDeal(sql, clinic.id, pipeline.id, stage1.id);

    await sql`UPDATE deals SET stage_id = ${stage2.id} WHERE id = ${deal.id}`;

    type AuditRow = {
      action: string;
      resource: string;
      metadata: { before: Record<string, unknown>; after: Record<string, unknown> };
    };
    const logs = await sql<AuditRow[]>`
      SELECT action, resource, metadata
      FROM audit_logs
      WHERE resource_id = ${deal.id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(logs[0]?.action).toBe('deal.stage_changed');
    expect(logs[0]?.resource).toBe('deals');
    expect(logs[0]?.metadata?.before?.['stage_id']).toBe(stage1.id);
    expect(logs[0]?.metadata?.after?.['stage_id']).toBe(stage2.id);
  });
});

describe('pipelines: cascade delete', () => {
  it('deleting pipeline cascades to stages and deals', async () => {
    const clinic = await createTestClinic(sql, 'Cascade Delete');
    const pipeline = await createTestPipeline(sql, clinic.id);
    const stage = await createTestPipelineStage(sql, clinic.id, pipeline.id);
    const deal = await createTestDeal(sql, clinic.id, pipeline.id, stage.id);

    await sql`DELETE FROM pipelines WHERE id = ${pipeline.id}`;

    const stages = await sql`SELECT id FROM pipeline_stages WHERE id = ${stage.id}`;
    expect(stages).toHaveLength(0);

    const deals = await sql`SELECT id FROM deals WHERE id = ${deal.id}`;
    expect(deals).toHaveLength(0);
  });
});

describe('pipelines: only one default per clinic', () => {
  it('cannot have two default pipelines in same clinic', async () => {
    const clinic = await createTestClinic(sql, 'Default Unique');
    await createTestPipeline(sql, clinic.id, { isDefault: true });

    await expect(
      createTestPipeline(sql, clinic.id, { isDefault: true }),
    ).rejects.toThrow();
  });

  it('two clinics can each have their own default pipeline', async () => {
    const cA = await createTestClinic(sql, 'Default A');
    const cB = await createTestClinic(sql, 'Default B');

    await expect(createTestPipeline(sql, cA.id, { isDefault: true })).resolves.toBeDefined();
    await expect(createTestPipeline(sql, cB.id, { isDefault: true })).resolves.toBeDefined();
  });
});

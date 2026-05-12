import { describe, it, expect, afterAll } from 'vitest';
import {
  getServiceClient,
  createTestClinic,
  deleteTestClinic,
} from './helpers/setup.js';

const sql = getServiceClient();
const createdClinics: string[] = [];

afterAll(async () => {
  await Promise.all(createdClinics.map((id) => deleteTestClinic(sql, id)));
  await sql.end();
});

describe('clinics.scheduling_provider column (M1a-1)', () => {
  it('column exists, defaults to "none", CHECK enforces enum', async () => {
    const c = await createTestClinic(sql, 'SchedProv-Default');
    createdClinics.push(c.id);

    const [row] = await sql<{ scheduling_provider: string }[]>`
      SELECT scheduling_provider FROM clinics WHERE id = ${c.id}
    `;
    expect(row?.scheduling_provider).toBe('none');
  });

  it('accepts pep_ans and calcom; rejects arbitrary string', async () => {
    const c = await createTestClinic(sql, 'SchedProv-Enum');
    createdClinics.push(c.id);

    await sql`UPDATE clinics SET scheduling_provider = 'pep_ans' WHERE id = ${c.id}`;
    const [row1] = await sql<{ scheduling_provider: string }[]>`
      SELECT scheduling_provider FROM clinics WHERE id = ${c.id}
    `;
    expect(row1?.scheduling_provider).toBe('pep_ans');

    await sql`UPDATE clinics SET scheduling_provider = 'calcom' WHERE id = ${c.id}`;
    const [row2] = await sql<{ scheduling_provider: string }[]>`
      SELECT scheduling_provider FROM clinics WHERE id = ${c.id}
    `;
    expect(row2?.scheduling_provider).toBe('calcom');

    await expect(sql`
      UPDATE clinics SET scheduling_provider = 'random_invalid' WHERE id = ${c.id}
    `).rejects.toThrow(/check|violat/i);
  });

  it('rejects NULL', async () => {
    const c = await createTestClinic(sql, 'SchedProv-NotNull');
    createdClinics.push(c.id);
    await expect(sql`
      UPDATE clinics SET scheduling_provider = NULL WHERE id = ${c.id}
    `).rejects.toThrow(/null|violat/i);
  });
});

describe('pep_specialties (M1a-1)', () => {
  it('insert + select via service_role; UNIQUE(clinic_id, ans_id) blocks dup', async () => {
    const c = await createTestClinic(sql, 'PepSpec-Dup');
    createdClinics.push(c.id);

    await sql`
      INSERT INTO pep_specialties (clinic_id, ans_id, name)
      VALUES (${c.id}, '6', 'CARDIOLOGIA')
    `;
    const rows = await sql<{ name: string }[]>`
      SELECT name FROM pep_specialties WHERE clinic_id = ${c.id} AND ans_id = '6'
    `;
    expect(rows[0]?.name).toBe('CARDIOLOGIA');

    await expect(sql`
      INSERT INTO pep_specialties (clinic_id, ans_id, name)
      VALUES (${c.id}, '6', 'CARDIOLOGIA UPDATED')
    `).rejects.toThrow(/duplicate|unique/i);
  });

  it('active defaults true; CHECK enforces non-empty name', async () => {
    const c = await createTestClinic(sql, 'PepSpec-Active');
    createdClinics.push(c.id);

    const [row] = await sql<{ active: boolean }[]>`
      INSERT INTO pep_specialties (clinic_id, ans_id, name)
      VALUES (${c.id}, '7', 'TEST') RETURNING active
    `;
    expect(row?.active).toBe(true);

    await expect(sql`
      INSERT INTO pep_specialties (clinic_id, ans_id, name)
      VALUES (${c.id}, '8', '')
    `).rejects.toThrow(/check|violat/i);
  });
});

describe('pep_doctors specialty cross-tenant trigger (M1a-1)', () => {
  it('rejects doctor with specialty_id from different clinic', async () => {
    const a = await createTestClinic(sql, 'PepDoc-XtenantA');
    createdClinics.push(a.id);
    const b = await createTestClinic(sql, 'PepDoc-XtenantB');
    createdClinics.push(b.id);

    const [specA] = await sql<{ id: string }[]>`
      INSERT INTO pep_specialties (clinic_id, ans_id, name)
      VALUES (${a.id}, '6', 'CARDIOLOGIA A') RETURNING id
    `;

    await expect(sql`
      INSERT INTO pep_doctors (clinic_id, specialty_id, ans_id, full_name)
      VALUES (${b.id}, ${specA!.id}, 'd1', 'Dr. Forge')
    `).rejects.toThrow(/cross-tenant violation specialty/i);
  });

  it('accepts doctor with specialty_id from same clinic', async () => {
    const c = await createTestClinic(sql, 'PepDoc-Same');
    createdClinics.push(c.id);

    const [spec] = await sql<{ id: string }[]>`
      INSERT INTO pep_specialties (clinic_id, ans_id, name)
      VALUES (${c.id}, '6', 'CARDIOLOGIA') RETURNING id
    `;

    const [doc] = await sql<{ full_name: string }[]>`
      INSERT INTO pep_doctors (clinic_id, specialty_id, ans_id, full_name)
      VALUES (${c.id}, ${spec!.id}, 'doc-1', 'Dr. Real')
      RETURNING full_name
    `;
    expect(doc?.full_name).toBe('Dr. Real');
  });
});

describe('pep_procedures (M1a-1)', () => {
  it('is_nobrecard defaults false; accepts true', async () => {
    const c = await createTestClinic(sql, 'PepProc-Nobre');
    createdClinics.push(c.id);

    const [r1] = await sql<{ is_nobrecard: boolean }[]>`
      INSERT INTO pep_procedures (clinic_id, ans_id, name)
      VALUES (${c.id}, 'p1', 'Consulta Standard') RETURNING is_nobrecard
    `;
    expect(r1?.is_nobrecard).toBe(false);

    const [r2] = await sql<{ is_nobrecard: boolean }[]>`
      INSERT INTO pep_procedures (clinic_id, ans_id, name, is_nobrecard)
      VALUES (${c.id}, 'p2', 'Consulta NobreCard', true) RETURNING is_nobrecard
    `;
    expect(r2?.is_nobrecard).toBe(true);
  });

  it('specialty_id cross-tenant trigger rejects mismatch', async () => {
    const a = await createTestClinic(sql, 'PepProc-XtenantA');
    createdClinics.push(a.id);
    const b = await createTestClinic(sql, 'PepProc-XtenantB');
    createdClinics.push(b.id);

    const [specA] = await sql<{ id: string }[]>`
      INSERT INTO pep_specialties (clinic_id, ans_id, name)
      VALUES (${a.id}, '6', 'CARDIO A') RETURNING id
    `;

    await expect(sql`
      INSERT INTO pep_procedures (clinic_id, specialty_id, ans_id, name)
      VALUES (${b.id}, ${specA!.id}, 'p1', 'Consulta')
    `).rejects.toThrow(/cross-tenant violation specialty/i);
  });
});

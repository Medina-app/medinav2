import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lookupOrCreatePatientByPhone } from '../src/patients.js';
import { createTestClinic, createTestPatient, deleteTestClinic, getAdminSupabase } from './helpers.js';

const sb = getAdminSupabase();
const createdClinics: string[] = [];

afterAll(async () => {
  for (const id of createdClinics) await deleteTestClinic(sb, id);
});

async function makeClinic(name: string) {
  const c = await createTestClinic(sb, name);
  createdClinics.push(c.id);
  return c;
}

describe('lookupOrCreatePatientByPhone', () => {
  it('returns existing patient when phone matches in clinic', async () => {
    const clinic = await makeClinic('LookupExisting');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const created = await createTestPatient(sb, clinic.id, { phone });

    const result = await lookupOrCreatePatientByPhone(sb, clinic.id, phone);

    expect(result.created).toBe(false);
    expect(result.patient.id).toBe(created.id);
    expect(result.patient.phone).toBe(phone);
  });

  it('creates patient with source=whatsapp + full_name=phone when missing', async () => {
    const clinic = await makeClinic('LookupCreate');
    const phone = `+5511${Date.now().toString().slice(-9)}`;

    const result = await lookupOrCreatePatientByPhone(sb, clinic.id, phone);

    expect(result.created).toBe(true);
    expect(result.patient.phone).toBe(phone);
    expect(result.patient.fullName).toBe(phone);
    expect(result.patient.source).toBe('whatsapp');
  });

  it('respects clinic_id isolation: same phone in clinic B does not match clinic A', async () => {
    const clinicA = await makeClinic('IsolationA');
    const clinicB = await makeClinic('IsolationB');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    await createTestPatient(sb, clinicA.id, { phone });

    const result = await lookupOrCreatePatientByPhone(sb, clinicB.id, phone);

    expect(result.created).toBe(true);
    expect(result.patient.clinicId).toBe(clinicB.id);
  });
});

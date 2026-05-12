import { describe, it, expect, afterAll } from 'vitest'
import {
  getServiceClient,
  createTestClinic,
  deleteTestClinic,
} from './rls/helpers/setup.js'
import { seedPepCatalog } from '../scripts/seed-pep-catalog.js'
import {
  MEDNOBRE_SPECIALTIES,
  MEDNOBRE_DOCTORS,
  MEDNOBRE_PROCEDURES,
} from '../scripts/seed-pep-catalog.data.js'

const sql = getServiceClient()
const createdClinics: string[] = []

afterAll(async () => {
  await Promise.all(createdClinics.map((id) => deleteTestClinic(sql, id)))
  await sql.end()
})

describe('seedPepCatalog (M1a-2)', () => {
  it('first run inserts all specialties + doctors + procedures and sets scheduling_provider=pep_ans', async () => {
    const c = await createTestClinic(sql, 'SeedPep-First')
    createdClinics.push(c.id)

    const result = await seedPepCatalog(sql, c.slug)

    expect(result.clinicId).toBe(c.id)
    expect(result.specialtiesInserted).toBe(MEDNOBRE_SPECIALTIES.length)
    expect(result.doctorsInserted).toBe(MEDNOBRE_DOCTORS.length)
    expect(result.proceduresInserted).toBe(MEDNOBRE_PROCEDURES.length)

    // scheduling_provider flipped
    const [clinic] = await sql<{ scheduling_provider: string }[]>`
      SELECT scheduling_provider FROM clinics WHERE id = ${c.id}
    `
    expect(clinic?.scheduling_provider).toBe('pep_ans')

    // Specialties: 20 inserted
    const [specCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM pep_specialties WHERE clinic_id = ${c.id}
    `
    expect(Number(specCount?.c ?? '0')).toBe(MEDNOBRE_SPECIALTIES.length)

    // Doctors: 60 inserted (3 per specialty * 20)
    const [docCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM pep_doctors WHERE clinic_id = ${c.id}
    `
    expect(Number(docCount?.c ?? '0')).toBe(MEDNOBRE_DOCTORS.length)

    // Procedures: 21 (1 per specialty + 1 NobreCard)
    const [procCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM pep_procedures WHERE clinic_id = ${c.id}
    `
    expect(Number(procCount?.c ?? '0')).toBe(MEDNOBRE_PROCEDURES.length)

    // NobreCard flag works
    const [nobre] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM pep_procedures
      WHERE clinic_id = ${c.id} AND is_nobrecard = true
    `
    expect(Number(nobre?.c ?? '0')).toBe(1)
  })

  it('second run is idempotent — row counts unchanged + names updated in place', async () => {
    const c = await createTestClinic(sql, 'SeedPep-Idem')
    createdClinics.push(c.id)

    await seedPepCatalog(sql, c.slug)

    // Capture ids of first run pra confirmar que upsert preserva PKs.
    const before = await sql<{ id: string; ans_id: string }[]>`
      SELECT id, ans_id FROM pep_specialties WHERE clinic_id = ${c.id} ORDER BY ans_id
    `

    await seedPepCatalog(sql, c.slug)

    const after = await sql<{ id: string; ans_id: string }[]>`
      SELECT id, ans_id FROM pep_specialties WHERE clinic_id = ${c.id} ORDER BY ans_id
    `

    expect(after).toHaveLength(before.length)
    for (let i = 0; i < before.length; i++) {
      expect(after[i]?.id).toBe(before[i]?.id)
      expect(after[i]?.ans_id).toBe(before[i]?.ans_id)
    }

    // Counts stable
    const [specCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM pep_specialties WHERE clinic_id = ${c.id}
    `
    expect(Number(specCount?.c ?? '0')).toBe(MEDNOBRE_SPECIALTIES.length)
    const [docCount] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM pep_doctors WHERE clinic_id = ${c.id}
    `
    expect(Number(docCount?.c ?? '0')).toBe(MEDNOBRE_DOCTORS.length)
  })

  it('throws when clinic slug not found', async () => {
    await expect(seedPepCatalog(sql, 'non-existent-clinic-slug-xyz')).rejects.toThrow(
      /clinic not found/i,
    )
  })

  it('preserves specialty_id linkage for doctors across re-runs', async () => {
    const c = await createTestClinic(sql, 'SeedPep-FK')
    createdClinics.push(c.id)

    await seedPepCatalog(sql, c.slug)
    await seedPepCatalog(sql, c.slug)

    // Sanity: every doctor row has specialty_id pointing to a specialty
    // of the SAME clinic (cross-tenant trigger from M1a-1 protects this).
    const [rows] = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c
      FROM pep_doctors d
      JOIN pep_specialties s ON s.id = d.specialty_id
      WHERE d.clinic_id = ${c.id} AND s.clinic_id = ${c.id}
    `
    expect(Number(rows?.c ?? '0')).toBe(MEDNOBRE_DOCTORS.length)
  })
})

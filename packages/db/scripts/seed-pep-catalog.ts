/**
 * M1a-2: PEP catalog seed.
 *
 * Usage: `pnpm tsx packages/db/scripts/seed-pep-catalog.ts <clinic-slug>`
 *
 * Side effects:
 * 1. Sets clinics.scheduling_provider = 'pep_ans' (idempotent)
 * 2. Upserts pep_specialties (20 rows from MEDNOBRE_SPECIALTIES)
 * 3. Upserts pep_doctors linked via specialty_id (60 rows — 3 per specialty)
 * 4. Upserts pep_procedures (21 rows — 1 per specialty + 1 NobreCard demo)
 *
 * Idempotency: ON CONFLICT (clinic_id, ans_id) DO UPDATE SET name, active=true.
 * Re-running preserves UUIDs (no cascading FK churn).
 *
 * Returns counts for verification. Throws if clinic not found.
 */
import postgres from 'postgres'
import * as dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  MEDNOBRE_SPECIALTIES,
  MEDNOBRE_DOCTORS,
  MEDNOBRE_PROCEDURES,
} from './seed-pep-catalog.data.js'

export interface SeedResult {
  clinicId: string
  specialtiesInserted: number
  doctorsInserted: number
  proceduresInserted: number
}

export async function seedPepCatalog(
  sql: postgres.Sql,
  clinicSlug: string,
): Promise<SeedResult> {
  const [clinic] = await sql<{ id: string }[]>`
    SELECT id FROM clinics WHERE slug = ${clinicSlug} AND deleted_at IS NULL
  `
  if (!clinic) throw new Error(`seedPepCatalog: clinic not found for slug=${clinicSlug}`)
  const clinicId = clinic.id

  // 1. Set scheduling_provider = 'pep_ans' (M1a flag).
  await sql`UPDATE clinics SET scheduling_provider = 'pep_ans' WHERE id = ${clinicId}`

  // 2. Specialties — upsert.
  for (const spec of MEDNOBRE_SPECIALTIES) {
    await sql`
      INSERT INTO pep_specialties (clinic_id, ans_id, name, active)
      VALUES (${clinicId}, ${spec.ansId}, ${spec.name}, true)
      ON CONFLICT (clinic_id, ans_id) DO UPDATE
        SET name = EXCLUDED.name, active = true, updated_at = NOW()
    `
  }

  // Build ansId → specialty.id map for FK resolution in doctors+procedures.
  const specRows = await sql<{ id: string; ans_id: string }[]>`
    SELECT id, ans_id FROM pep_specialties WHERE clinic_id = ${clinicId}
  `
  const specByAnsId = new Map(specRows.map((r) => [r.ans_id, r.id]))

  // 3. Doctors — upsert. specialty_id resolved via map.
  for (const doc of MEDNOBRE_DOCTORS) {
    const specialtyId = specByAnsId.get(doc.specialtyAnsId)
    if (!specialtyId) {
      throw new Error(
        `seedPepCatalog: doctor ans_id=${doc.ansId} references unknown specialty ans_id=${doc.specialtyAnsId}`,
      )
    }
    await sql`
      INSERT INTO pep_doctors (clinic_id, specialty_id, ans_id, full_name, crm, crm_state, active)
      VALUES (${clinicId}, ${specialtyId}, ${doc.ansId}, ${doc.fullName}, ${doc.crm ?? null}, ${doc.crmState ?? null}, true)
      ON CONFLICT (clinic_id, ans_id) DO UPDATE
        SET full_name = EXCLUDED.full_name,
            specialty_id = EXCLUDED.specialty_id,
            crm = EXCLUDED.crm,
            crm_state = EXCLUDED.crm_state,
            active = true,
            updated_at = NOW()
    `
  }

  // 4. Procedures — upsert. specialty_id optional.
  for (const proc of MEDNOBRE_PROCEDURES) {
    const specialtyId =
      proc.specialtyAnsId != null ? (specByAnsId.get(proc.specialtyAnsId) ?? null) : null
    await sql`
      INSERT INTO pep_procedures (clinic_id, specialty_id, ans_id, name, is_nobrecard, active)
      VALUES (${clinicId}, ${specialtyId}, ${proc.ansId}, ${proc.name}, ${proc.isNobrecard}, true)
      ON CONFLICT (clinic_id, ans_id) DO UPDATE
        SET name = EXCLUDED.name,
            specialty_id = EXCLUDED.specialty_id,
            is_nobrecard = EXCLUDED.is_nobrecard,
            active = true,
            updated_at = NOW()
    `
  }

  return {
    clinicId,
    specialtiesInserted: MEDNOBRE_SPECIALTIES.length,
    doctorsInserted: MEDNOBRE_DOCTORS.length,
    proceduresInserted: MEDNOBRE_PROCEDURES.length,
  }
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────
// Run via: `pnpm tsx packages/db/scripts/seed-pep-catalog.ts <clinic-slug>`
const __dirname = dirname(fileURLToPath(import.meta.url))

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] != null &&
  process.argv[1].includes('seed-pep-catalog')

if (isMain) {
  dotenv.config({ path: resolve(__dirname, '../../../apps/web/.env.local') })
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) {
    console.error('DATABASE_URL not set in apps/web/.env.local')
    process.exit(1)
  }
  const clinicSlug = process.argv[2]
  if (!clinicSlug) {
    console.error('usage: pnpm tsx packages/db/scripts/seed-pep-catalog.ts <clinic-slug>')
    process.exit(1)
  }
  const sql = postgres(databaseUrl, { max: 1 })
  seedPepCatalog(sql, clinicSlug)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
      return sql.end()
    })
    .catch(async (err) => {
      console.error('seed-pep-catalog failed:', err)
      await sql.end()
      process.exit(1)
    })
}

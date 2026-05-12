/**
 * Mednobre PEP catalog seed data.
 *
 * Specialties: 20 reais do ANS Mednobre (id ANS → nome exato).
 * Doctors: 3 placeholders por specialty marcados TODO. Substituir pelo
 *   catálogo real quando CSV/JSON da Mednobre disponível.
 * Procedures: 1 procedure placeholder por specialty + 1 NobreCard de
 *   demonstração. Substituir com lista real Mednobre.
 *
 * Re-run idempotente via UNIQUE(clinic_id, ans_id) — ON CONFLICT DO UPDATE
 * atualiza name preservando id.
 */

export interface SeedSpecialty {
  ansId: string
  name: string
}

export interface SeedDoctor {
  ansId: string
  fullName: string
  /** Liga doctor a specialty via ansId (não id local — script resolve). */
  specialtyAnsId: string
  crm?: string
  crmState?: string
}

export interface SeedProcedure {
  ansId: string
  name: string
  /** Liga a specialty via ansId (opcional). */
  specialtyAnsId?: string
  isNobrecard: boolean
}

export const MEDNOBRE_SPECIALTIES: ReadonlyArray<SeedSpecialty> = [
  { ansId: '6', name: 'CARDIOLOGIA' },
  { ansId: '11', name: 'CIRURGIA GERAL' },
  { ansId: '15', name: 'CIRURGIA VASCULAR' },
  { ansId: '16', name: 'CLÍNICA MÉDICA' },
  { ansId: '18', name: 'DERMATOLOGIA' },
  { ansId: '19', name: 'ENDOCRINOLOGIA E METABOLOGIA' },
  { ansId: '59', name: 'FONOAUDIOLOGIA' },
  { ansId: '21', name: 'GASTROENTEROLOGIA' },
  { ansId: '23', name: 'GERIATRIA' },
  { ansId: '24', name: 'GINECOLOGIA E OBSTETRÍCIA' },
  { ansId: '29', name: 'NEFROLOGIA' },
  { ansId: '31', name: 'NEUROLOGIA' },
  { ansId: '64', name: 'NUTRIÇÃO' },
  { ansId: '34', name: 'ORTOPEDIA E TRAUMATOLOGIA' },
  { ansId: '35', name: 'OTORRINOLARINGOLOGIA' },
  { ansId: '37', name: 'PEDIATRIA' },
  { ansId: '58', name: 'PSICOLOGIA' },
  { ansId: '40', name: 'PSIQUIATRIA' },
  { ansId: '41', name: 'RADIOLOGIA E DIAGNÓSTICO POR IMAGEM' },
  { ansId: '44', name: 'UROLOGIA' },
]

/**
 * TODO: substituir com dados reais Mednobre.
 *
 * Gera 3 placeholders por specialty. ans_id derivado: `doc-{specialtyAnsId}-{idx}`
 * (e.g. doc-6-1, doc-6-2, doc-6-3 pra CARDIOLOGIA). Quando catálogo real
 * disponível, basta substituir esse array.
 */
export const MEDNOBRE_DOCTORS: ReadonlyArray<SeedDoctor> = MEDNOBRE_SPECIALTIES.flatMap(
  (spec, specIdx) =>
    [1, 2, 3].map((idx) => ({
      // TODO: substituir com dados reais Mednobre (ans_id real do doctor,
      // full_name real, crm + crm_state quando aplicável).
      ansId: `doc-${spec.ansId}-${idx}`,
      fullName: `[Placeholder] Dr(a) ${spec.name.split(' ')[0]} ${idx} (specialty ${specIdx + 1})`,
      specialtyAnsId: spec.ansId,
      crm: undefined,
      crmState: undefined,
    })),
)

/**
 * TODO: substituir com dados reais Mednobre.
 *
 * Stub mínimo: 1 procedure "Consulta" por specialty (não-nobrecard) +
 * 1 NobreCard de exemplo (CARDIOLOGIA — consulta inicial). Substituir pela
 * lista real Mednobre com flag is_nobrecard correta por procedure.
 */
export const MEDNOBRE_PROCEDURES: ReadonlyArray<SeedProcedure> = [
  ...MEDNOBRE_SPECIALTIES.map((spec) => ({
    ansId: `proc-${spec.ansId}-consulta`,
    name: `Consulta ${spec.name}`,
    specialtyAnsId: spec.ansId,
    isNobrecard: false,
  })),
  // Exemplo NobreCard pra Mednobre validar o flag
  {
    ansId: 'proc-6-consulta-nobrecard',
    name: 'Consulta CARDIOLOGIA (NobreCard)',
    specialtyAnsId: '6',
    isNobrecard: true,
  },
]

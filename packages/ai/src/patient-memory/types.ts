import { z } from 'zod'

export const FactCategorySchema = z.enum(['administrative', 'financial'])
export type FactCategory = z.infer<typeof FactCategorySchema>

/**
 * Whitelist de keys por categoria. Qualquer fact com key fora deste set
 * é descartado pelo extractor (defense in depth contra Haiku desobedecendo
 * o prompt). Mantém alinhado com SYSTEM_PROMPT em extractor.ts.
 */
export const ALLOWED_KEYS: Readonly<Record<FactCategory, ReadonlySet<string>>> = {
  administrative: new Set([
    'preferred_name',
    'full_name',
    'age',
    'profession',
    'address_neighborhood',
  ]),
  financial: new Set([
    'health_plan_name',
    'preferred_payment_method',
  ]),
}

/**
 * LGPD blocklist: palavras-gatilho que indicam fato médico/PHI. Mesmo que o
 * Haiku categorize como administrativo, value contendo qualquer destas é
 * descartado silenciosamente. Cobre PT-BR com/sem acento.
 */
export const MEDICAL_BLOCKLIST_RE =
  /\b(gr[áa]vid[ao]s?|diagn[óo]sticos?|sintomas?|medica[çc][ãa]o|medica[çc][õo]es|rem[ée]dios?|alergias?|dor(?:es)?|doen[çc]as?)\b/i

/** Output do extractor (raw — antes de persistir). */
export const ExtractedFactSchema = z.object({
  category: FactCategorySchema,
  key: z.string().min(1).max(64),
  value: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
})
export type ExtractedFact = z.infer<typeof ExtractedFactSchema>

export const ExtractionOutputSchema = z.object({
  facts: z.array(ExtractedFactSchema),
})

/** Fact persistido (row do DB, snake_case → camelCase). */
export interface PatientFact {
  id: string
  clinicId: string
  patientId: string
  category: FactCategory
  key: string
  value: string
  confidence: number
  sourceConversationId: string | null
  sourceMessageId: string | null
  lastReferencedAt: string
  createdAt: string
  updatedAt: string
}

/** Config lida de clinics.metadata->'ai_memory'. */
export interface AiMemoryConfig {
  enabled: boolean
  categories: FactCategory[]
}

/** Default: memory desligado, nenhuma categoria. */
export const DEFAULT_AI_MEMORY_CONFIG: AiMemoryConfig = {
  enabled: false,
  categories: [],
}

export function parseAiMemoryConfig(raw: unknown): AiMemoryConfig {
  if (raw == null || typeof raw !== 'object') return DEFAULT_AI_MEMORY_CONFIG
  const obj = raw as Record<string, unknown>
  const enabled = obj['enabled'] === true
  const rawCats = obj['categories']
  const categories: FactCategory[] = Array.isArray(rawCats)
    ? rawCats.filter(
        (c): c is FactCategory => c === 'administrative' || c === 'financial',
      )
    : []
  return { enabled, categories }
}

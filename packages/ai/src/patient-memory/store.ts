import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExtractedFact, FactCategory, PatientFact } from './types.js'

type ForgetReason = 'user_request' | 'admin_delete'

interface PatientFactRow {
  id: string
  clinic_id: string
  patient_id: string
  category: FactCategory
  key: string
  value: string
  confidence: string | number
  source_conversation_id: string | null
  source_message_id: string | null
  last_referenced_at: string
  created_at: string
  updated_at: string
}

function rowToFact(row: PatientFactRow): PatientFact {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    patientId: row.patient_id,
    category: row.category,
    key: row.key,
    value: row.value,
    confidence:
      typeof row.confidence === 'number' ? row.confidence : parseFloat(row.confidence),
    sourceConversationId: row.source_conversation_id,
    sourceMessageId: row.source_message_id,
    lastReferencedAt: row.last_referenced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Lê facts ativos (deleted_at IS NULL) da clínica + paciente, ordenados por
 * categoria → key. Usa RLS — caller pode ser authenticated (membro da clínica)
 * ou service_role.
 */
export async function loadPatientFacts(
  supabase: SupabaseClient,
  clinicId: string,
  patientId: string,
): Promise<PatientFact[]> {
  const { data, error } = await supabase
    .from('patient_facts')
    .select(
      'id, clinic_id, patient_id, category, key, value, confidence, source_conversation_id, source_message_id, last_referenced_at, created_at, updated_at',
    )
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .is('deleted_at', null)
    .order('category', { ascending: true })

  if (error) {
    throw new Error(`loadPatientFacts: ${error.message}`)
  }
  return (data ?? []).map((r) => rowToFact(r as PatientFactRow))
}

export interface UpsertSourceIds {
  conversationId: string
  messageId?: string
}

export interface UpsertResult {
  inserted: number
  updated: number
}

/**
 * Insert ou update facts via ON CONFLICT (clinic_id, patient_id, category, key).
 * Service_role only — RLS bloqueia INSERT/UPDATE pra authenticated.
 *
 * Caller é responsável por ter pré-filtrado facts (whitelist + blocklist) via
 * createFactsExtractor antes de chamar aqui.
 */
export async function upsertFacts(
  supabase: SupabaseClient,
  clinicId: string,
  patientId: string,
  facts: ReadonlyArray<ExtractedFact>,
  source: UpsertSourceIds,
): Promise<UpsertResult> {
  if (facts.length === 0) {
    return { inserted: 0, updated: 0 }
  }

  const now = new Date().toISOString()
  const rows = facts.map((f) => ({
    clinic_id: clinicId,
    patient_id: patientId,
    category: f.category,
    key: f.key,
    value: f.value,
    confidence: f.confidence,
    source_conversation_id: source.conversationId,
    source_message_id: source.messageId ?? null,
    last_referenced_at: now,
  }))

  const { data, error } = await supabase
    .from('patient_facts')
    .upsert(rows, { onConflict: 'clinic_id,patient_id,category,key' })
    .select('id')

  if (error) {
    throw new Error(`upsertFacts: ${error.message}`)
  }

  // PostgREST não distingue insert vs update no count; aproximação: data.length
  // total. Para métricas reais, comparar com loadPatientFacts antes/depois — fora
  // do escopo da função.
  return { inserted: data?.length ?? 0, updated: 0 }
}

/**
 * Chama RPC forget_patient_facts (SECURITY DEFINER). Caller deve ser
 * authenticated com role admin/owner. Retorna número de rows soft-deleted.
 */
export async function forgetFacts(
  supabase: SupabaseClient,
  patientId: string,
  category?: FactCategory,
  reason: ForgetReason = 'user_request',
): Promise<number> {
  const { data, error } = await supabase.rpc('forget_patient_facts', {
    p_patient_id: patientId,
    p_category: category ?? null,
    p_reason: reason,
  })

  if (error) {
    throw new Error(error.message)
  }
  return typeof data === 'number' ? data : 0
}

/**
 * Fire-and-forget: atualiza last_referenced_at pros facts usados no contexto.
 * Service_role only. Erros são silenciados — touch failure não pode quebrar
 * dispatch.
 */
export async function touchFacts(
  supabase: SupabaseClient,
  factIds: ReadonlyArray<string>,
): Promise<void> {
  if (factIds.length === 0) return
  await supabase
    .from('patient_facts')
    .update({ last_referenced_at: new Date().toISOString() })
    .in('id', factIds as string[])
  // Não throw mesmo em erro — fire-and-forget.
}

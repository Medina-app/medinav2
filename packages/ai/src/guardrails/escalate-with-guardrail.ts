/**
 * AI-5 — Helper de escalação por guardrail.
 *
 * Encapsula as 2 operações que toda escalação por guardrail precisa fazer:
 *   1. RPC atomic: escalate_conversation_with_reason (state + escalated_via='ai'
 *      + escalated_reason=<categoria> + system message 🛡️ + audit_logs).
 *   2. Insert canned response (sender_type='ai') no outbox pra paciente —
 *      garante que paciente NUNCA fica em silêncio até atendente assumir.
 *
 * Exposto pra dispatcher (Task 9) chamar quando pre-filter, urgency-detector
 * ou post-filter dispararem. Intencionalmente NÃO acessa Langfuse aqui;
 * dispatcher detém o contexto de trace (Task 11 adiciona spans).
 *
 * Idempotência herdada da RPC: se conversa já está em waiting_human, RPC
 * retorna false e este helper SAI sem inserir canned (evita duplicar
 * mensagens caso 2 paths concorrentes acionem guardrail simultaneamente).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getCannedResponse } from './canned-responses.js'
import type { EscalatedReason } from './types.js'

export interface EscalateWithGuardrailArgs {
  supabase: SupabaseClient
  clinicId: string
  conversationId: string
  /** agent_configs.id pra registrar autoria da canned message (audit). */
  agentConfigId: string
  reasonCategory: EscalatedReason
  /** Texto livre pro audit (max 500 chars enforcado pelo RPC). */
  reasonText: string
}

export interface EscalateWithGuardrailResult {
  /** Id da canned message inserida; '' quando RPC retornou false (já escalada). */
  cannedMessageId: string
  /** Whether the RPC actually transitioned (vs. idempotent no-op). */
  escalated: boolean
}

export async function escalateWithGuardrail(
  args: EscalateWithGuardrailArgs,
): Promise<EscalateWithGuardrailResult> {
  const {
    supabase,
    clinicId,
    conversationId,
    agentConfigId,
    reasonCategory,
    reasonText,
  } = args

  // Truncate reason pra respeitar contrato do RPC (length(trim) >= 3, sem
  // upper bound HARD mas system message inline fica ilegível).
  const trimmedReason = reasonText.trim().slice(0, 500)
  const safeReason = trimmedReason.length >= 3 ? trimmedReason : `guardrail: ${reasonCategory}`

  const { data, error } = await supabase.rpc('escalate_conversation_with_reason', {
    p_conversation_id: conversationId,
    p_clinic_id: clinicId,
    p_reason: safeReason,
    p_reason_category: reasonCategory,
  })
  if (error) {
    throw new Error(`escalate_with_reason: ${error.message}`)
  }

  // RPC retorna false se conversa já está em waiting_human — algum outro
  // worker escalou simultaneamente. Deixa stack como está; não duplica
  // canned message (paciente já tem retorno do escalation original).
  if (data === false) {
    return { cannedMessageId: '', escalated: false }
  }

  const canned = getCannedResponse(reasonCategory)
  const { data: msg, error: insErr } = await supabase
    .from('messages')
    .insert({
      clinic_id: clinicId,
      conversation_id: conversationId,
      direction: 'outbound',
      sender_type: 'ai',
      sender_user_id: null,
      content_type: 'text',
      content: canned,
      external_id: null,
      delivery_status: 'pending',
      outbox_status: 'pending',
      agent_config_id: agentConfigId,
    })
    .select('id')
    .single()

  if (insErr || !msg) {
    throw new Error(`canned response insert: ${insErr?.message ?? 'unknown'}`)
  }
  return { cannedMessageId: (msg as { id: string }).id, escalated: true }
}

import type { Agent } from '@mastra/core/agent'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { GuardrailsConfig } from './guardrails/types.js'

/** AI-4: minimal Cal.com client interface — concrete impl em
 * `@medina/integrations-calcom`. Tools fazem dep injection via ToolContext;
 * agent-factory instancia o client quando clinic_integrations Cal.com
 * ativa existir. Tipo via interface evita @medina/ai → @medina/integrations
 * dep cíclica. */
export interface CalcomClientLike {
  getAvailability(args: {
    eventTypeId: number
    startTime: string
    endTime: string
  }): Promise<Array<{ start: string; end: string }>>
  createBooking(input: {
    eventTypeId: number
    start: string
    attendee: { email: string; name: string; timeZone: string }
    metadata?: Record<string, unknown>
  }): Promise<{ id: number; uid: string; startTime: string; endTime: string }>
  cancelBooking(uid: string, cancellationReason: string): Promise<void>
  rescheduleBooking(uid: string, newStart: string): Promise<{ id: number; uid: string }>
}

export interface AgentConfig {
  id: string
  clinicId: string
  name: string
  version: number
  status: 'draft' | 'published' | 'archived'
  systemPrompt: string
  model: string
  temperature: number
  maxTokens: number
  tools: string[]
  /** AI-5: per-clinic override of TS default guardrail patterns. Stored as
   *  jsonb in agent_configs.guardrails. Empty `{}` means "use defaults". */
  guardrails: GuardrailsConfig
  knowledgeDocumentIds: string[]
  /** Issue #21: per-clinic search_kb similarity threshold [0, 1]. PostgREST
   *  serializes NUMERIC como string ("0.40"); factory parser converte pra
   *  number antes de propagar pra ToolContext. */
  kbSimilarityThreshold: number
}

export interface RetrievedChunk {
  id: string
  documentId: string
  content: string
  similarity: number
}

/**
 * Closure context every tool receives at construction time. Tools must use
 * `supabase` (service role) for any DB interaction so RLS doesn't block them.
 * `clinicId` and `conversationId` are required — every tool runs inside a
 * dispatch with those values bound.
 */
export interface ToolContext {
  clinicId: string
  conversationId: string
  patientId?: string
  /** Optional uuid[] from agent_config.knowledge_document_ids. Empty/undefined
   *  means "search all KB documents for this clinic" — search_kb tool converts
   *  empty to undefined so retrieveKnowledge passes null to the RPC. */
  knowledgeDocumentIds?: readonly string[]
  /** Issue #21: per-clinic search_kb similarity threshold [0, 1]. Undefined
   *  cai pro DEFAULT_THRESHOLD_FALLBACK em search-kb.ts (back-compat). */
  kbSimilarityThreshold?: number
  supabase: SupabaseClient
  /** AI-4: Cal.com client instance — undefined quando clinic_integrations
   *  Cal.com não existe / está disabled. Tools Cal.com checkam presença e
   *  retornam erro estruturado (não throw) se ausente. */
  calcomClient?: CalcomClientLike
  /** AI-4: default eventTypeId pra clinic — fallback quando doctor.calcom_event_type_ids[0]
   *  ausente. Vem de clinic_integrations.config.default_event_type_id. */
  calcomDefaultEventTypeId?: number
}

export interface AgentResponse {
  text: string
  finishReason: string
}

export interface CreateAgentResult {
  agent: Agent
  config: AgentConfig
}

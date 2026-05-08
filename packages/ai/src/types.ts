import type { Agent } from '@mastra/core/agent'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { GuardrailsConfig } from './guardrails/types.js'

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
}

export interface AgentResponse {
  text: string
  finishReason: string
}

export interface CreateAgentResult {
  agent: Agent
  config: AgentConfig
}

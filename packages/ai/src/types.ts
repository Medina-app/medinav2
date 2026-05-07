import type { Agent } from '@mastra/core/agent'
import type { SupabaseClient } from '@supabase/supabase-js'

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
  guardrails: string[]
  knowledgeDocumentIds: string[]
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

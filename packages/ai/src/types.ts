import type { Agent } from '@mastra/core'

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

export interface ToolContext {
  clinicId: string
  patientId?: string
  conversationId?: string
}

export interface AgentResponse {
  text: string
  finishReason: string
}

export interface CreateAgentResult {
  agent: Agent
  config: AgentConfig
}

import { Agent } from '@mastra/core/agent'
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AgentNotFoundError, NamespacingViolationError } from './errors.js'
import type { AgentConfig, CreateAgentResult } from './types.js'

export interface CreateAgentOpts {
  clinicId: string
  agentName?: string
  supabase: SupabaseClient
}

function resolveModel(modelId: string) {
  if (modelId.startsWith('claude-')) {
    return anthropic(modelId)
  }
  return openai(modelId)
}

function rowToConfig(row: Record<string, unknown>): AgentConfig {
  return {
    id: row['id'] as string,
    clinicId: row['clinic_id'] as string,
    name: row['name'] as string,
    version: row['version'] as number,
    status: row['status'] as AgentConfig['status'],
    systemPrompt: row['system_prompt'] as string,
    model: row['model'] as string,
    temperature: parseFloat(row['temperature'] as string),
    maxTokens: row['max_tokens'] as number,
    tools: (row['tools'] as string[] | null) ?? [],
    guardrails: (row['guardrails'] as string[] | null) ?? [],
    knowledgeDocumentIds: (row['knowledge_document_ids'] as string[] | null) ?? [],
  }
}

export async function createAgent(opts: CreateAgentOpts): Promise<CreateAgentResult> {
  const { clinicId, agentName = 'default', supabase } = opts

  const { data, error } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('name', agentName)
    .eq('status', 'published')
    .single()

  if (error != null || data == null) {
    throw new AgentNotFoundError(clinicId, agentName)
  }

  const row = data as Record<string, unknown>

  if (row['clinic_id'] !== clinicId) {
    throw new NamespacingViolationError(
      `agent_config clinic_id "${String(row['clinic_id'])}" does not match requested clinicId "${clinicId}"`
    )
  }

  const config = rowToConfig(row)
  const model = resolveModel(config.model)

  const agent = new Agent({
    id: `clinic:${clinicId}:agent:${config.name}:v${config.version}`,
    name: config.name,
    model,
    instructions: config.systemPrompt,
  })

  return { agent, config }
}

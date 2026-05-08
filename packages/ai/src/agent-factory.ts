import { Agent } from '@mastra/core/agent'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AgentNotFoundError, NamespacingViolationError } from './errors.js'
import type { AgentConfig, CreateAgentResult } from './types.js'
import type { GuardrailsConfig } from './guardrails/types.js'

export interface CreateAgentOpts {
  clinicId: string
  /** Defaults to 'agente-principal'. Multi-agent routing future-proofing (fix #8). */
  agentName?: string
  supabase: SupabaseClient
  /** Tool record built by buildToolsFromConfig, keyed by tool id. */
  tools?: Record<string, unknown>
}

// All models go through OpenRouter — use the model id from agent_configs.model
// directly (e.g. 'anthropic/claude-sonnet-4-5', 'openai/gpt-4o', 'meta-llama/...').
// One provider, one API key, switching models becomes a config change.
function resolveModel(modelId: string) {
  const apiKey = process.env['OPENROUTER_API_KEY']
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set')
  const openrouter = createOpenRouter({ apiKey })
  return openrouter(modelId)
}

/**
 * AI-5: agent_configs.guardrails é jsonb (object). Coalesce null/array (legacy
 * row defensiveness) → {}. Cast pra GuardrailsConfig sem validar shape — campos
 * extras viram no-ops em mergeGuardrails (defaults.ts), e campos esperados são
 * tipados nos consumers (pre-filter, urgency-detector, post-filter).
 */
function parseGuardrails(raw: unknown): GuardrailsConfig {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as GuardrailsConfig
}

/** Issue #21: PostgREST serializa NUMERIC como string ("0.40"); converte pra
 *  number com fallback 0.4 se NULL/missing (back-compat com rows pré-0025). */
function parseKbThreshold(raw: unknown): number {
  if (raw == null) return 0.4
  if (typeof raw === 'number') return raw
  const parsed = parseFloat(String(raw))
  return Number.isFinite(parsed) ? parsed : 0.4
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
    guardrails: parseGuardrails(row['guardrails']),
    knowledgeDocumentIds: (row['knowledge_document_ids'] as string[] | null) ?? [],
    kbSimilarityThreshold: parseKbThreshold(row['kb_similarity_threshold']),
  }
}

export async function createAgent(opts: CreateAgentOpts): Promise<CreateAgentResult> {
  const { clinicId, agentName = 'agente-principal', supabase, tools } = opts

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
    // tools is Record<string, unknown> at our boundary; Mastra expects
    // ToolsInput (Record<string, ToolAction|...>). buildToolsFromConfig only
    // populates entries from createTool() so the runtime shape is correct.
    ...(tools ? { tools: tools as never } : {}),
  })

  return { agent, config }
}

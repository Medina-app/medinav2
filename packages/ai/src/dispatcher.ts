import type { SupabaseClient } from '@supabase/supabase-js'
import { createAgent } from './agent-factory.js'
import { getLangfuseClient, withTrace, type LangfuseTrace } from './langfuse.js'
import { AgentDispatchSkipped } from './errors.js'
import { buildToolsFromConfig } from './tools/build.js'
import type { ToolContext } from './types.js'

const HISTORY_LIMIT = 20
/** Cap the agent loop. AI-SDK default is 1 (single-shot), which would prevent
 *  the LLM from speaking after a tool call. 5 lets typical "tool→reply" flows
 *  finish (escalate→goodbye, business_hours→answer) without infinite loops. */
const MAX_STEPS = 5

export interface DispatchAgentArgs {
  conversationId: string
  clinicId: string
  /** The inbound message that triggered dispatch — used for logs/tracing only. */
  messageId: string
  supabase: SupabaseClient
  /** Optional override; defaults to 'agente-principal' (multi-agent prep). */
  agentName?: string
}

export interface DispatchResult {
  /** Id of the AI-generated message inserted into the outbox. Empty when escalate
   *  ran with no goodbye text — nothing was added to the outbox. */
  messageId: string
  traceId: string | null
  tokensIn: number
  tokensOut: number
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ToolCallStep { payload?: { toolName?: string } }
interface AgentStep { toolCalls?: ToolCallStep[] }

/**
 * Loads the conversation, the published agent_config, the last 20 messages,
 * generates a reply via the Mastra agent, and inserts the response into the
 * outbox (outbox_status='pending') for the CHAT-2 worker to send.
 *
 * Skips (throws AgentDispatchSkipped) when:
 *   - conversation.state !== 'ai_handling'
 *   - no published agent_config for the (clinic, agentName) pair
 *
 * Throws (caller's Inngest worker retries):
 *   - cross-tenant violation (defense in depth — adapter already filters)
 *   - LLM errors (rate limit, timeout)
 *   - DB errors on insert
 */
export async function dispatchAgent(args: DispatchAgentArgs): Promise<DispatchResult> {
  const { supabase, conversationId, clinicId, agentName = 'agente-principal' } = args

  // 1. Load conversation + verify state and clinic ownership.
  const { data: conv, error: cErr } = await supabase
    .from('conversations')
    .select('id, state, clinic_id, patient_id')
    .eq('id', conversationId)
    .single()
  if (cErr || !conv) {
    throw new Error(`conversation lookup failed: ${cErr?.message ?? 'not found'}`)
  }
  if (conv.clinic_id !== clinicId) {
    throw new Error(
      `cross-tenant violation: conversation ${conversationId} belongs to ${String(conv.clinic_id)}, not ${clinicId}`,
    )
  }
  if (conv.state !== 'ai_handling') {
    throw new AgentDispatchSkipped('state_not_ai_handling')
  }

  // 2. Load the active published agent_config for this clinic + agentName.
  const { data: cfg } = await supabase
    .from('agent_configs')
    .select('id, system_prompt, model, temperature, max_tokens, name, tools')
    .eq('clinic_id', clinicId)
    .eq('status', 'published')
    .eq('name', agentName)
    .maybeSingle()
  if (!cfg) {
    throw new AgentDispatchSkipped('no_agent_config')
  }

  // 3. Last N messages, oldest-first for the LLM context window.
  const { data: history } = await supabase
    .from('messages')
    .select('content, sender_type, direction, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)

  const messages: ChatMessage[] = (history ?? [])
    .slice()
    .reverse()
    .map((m) => ({
      role: m.sender_type === 'patient' ? ('user' as const) : ('assistant' as const),
      content: m.content ?? '',
    }))

  // 4. Build tools bound to this dispatch context, then construct the agent.
  const toolNames = (cfg.tools as string[] | null) ?? []
  const toolCtx: ToolContext = { clinicId, conversationId, supabase }
  const tools = buildToolsFromConfig(toolCtx, toolNames)
  const { agent } = await createAgent({ clinicId, agentName, supabase, tools })

  // 5. Trace + generate. withTrace handles failsafe — if Langfuse is down,
  // trace becomes null and the agent still runs; LLM errors propagate.
  const langfuse = getLangfuseClient()
  const sessionId = `clinic:${clinicId}:conv:${conversationId}`
  const start = Date.now()

  return withTrace(
    langfuse,
    {
      name: 'dispatch-agent',
      sessionId,
      metadata: {
        conversationId,
        clinicId,
        model: cfg.model,
        agentConfigId: cfg.id,
        triggerMessageId: args.messageId,
        toolNames,
      },
    },
    async (trace: LangfuseTrace | null): Promise<DispatchResult> => {
      const generation = trace?.generation?.({
        name: 'agent.generate',
        model: cfg.model,
        input: messages,
      }) as { end?: (args: Record<string, unknown>) => void } | undefined

      // FIX #7: pass temperature + maxTokens via Mastra's modelSettings.
      // AI-SDK v5 renamed maxTokens → maxOutputTokens; verified in
      // @mastra/core 1.32.1 agent.types.d.ts (modelSettings: CallSettings).
      let result
      try {
        result = await agent.generate(messages, {
          maxSteps: MAX_STEPS,
          modelSettings: {
            temperature: cfg.temperature,
            maxOutputTokens: cfg.max_tokens,
          },
        })
        try {
          generation?.end?.({
            output: (result as { text?: string }).text ?? '',
            usage: (result as { totalUsage?: unknown }).totalUsage ?? {},
          })
        } catch {
          /* swallow */
        }
      } catch (err) {
        try {
          generation?.end?.({ level: 'ERROR', statusMessage: String(err) })
        } catch {
          /* swallow */
        }
        throw err
      }

      const text = (result as { text?: string }).text ?? ''
      const usage = (result as { totalUsage?: { inputTokens?: number; outputTokens?: number } })
        .totalUsage ?? {}

      // 6. Detect escalation. If the LLM called escalate_to_human, the tool
      //    already inserted a system message and flipped state. We still
      //    insert the goodbye text if the LLM produced one — but skip the
      //    insert when text is empty/whitespace.
      const steps = ((result as { steps?: AgentStep[] }).steps) ?? []
      const escalated = steps.some((s) =>
        (s.toolCalls ?? []).some((tc) => tc.payload?.toolName === 'escalate_to_human'),
      )

      // Emit one Langfuse span per tool call (post-hoc — Mastra emits OTel
      // but the manual generation API doesn't auto-attach those spans).
      try {
        for (const step of steps) {
          for (const tc of step.toolCalls ?? []) {
            ;(trace as unknown as { span?: (a: Record<string, unknown>) => void } | null)
              ?.span?.({ name: `tool:${tc.payload?.toolName ?? 'unknown'}`, input: tc })
          }
        }
      } catch {
        /* swallow */
      }

      let messageId = ''
      if (!escalated || text.trim().length > 0) {
        const { data: msg, error: mErr } = await supabase
          .from('messages')
          .insert({
            clinic_id: clinicId,
            conversation_id: conversationId,
            direction: 'outbound',
            sender_type: 'ai',
            sender_user_id: null,
            content_type: 'text',
            content: text,
            external_id: null,
            delivery_status: 'pending',
            outbox_status: 'pending',
            agent_config_id: cfg.id,
          })
          .select('id')
          .single()
        if (mErr || !msg) {
          throw new Error(`message insert failed: ${mErr?.message ?? 'unknown'}`)
        }
        messageId = (msg as { id: string }).id
      }

      try {
        trace?.score?.({ name: 'latency_ms', value: Date.now() - start })
      } catch {
        /* swallow */
      }

      return {
        messageId,
        traceId: trace?.id ?? null,
        tokensIn: usage.inputTokens ?? 0,
        tokensOut: usage.outputTokens ?? 0,
      }
    },
  )
}

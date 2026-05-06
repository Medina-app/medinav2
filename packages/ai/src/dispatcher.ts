import type { SupabaseClient } from '@supabase/supabase-js'
import { createAgent } from './agent-factory.js'
import { getLangfuseClient, withTrace, type LangfuseTrace } from './langfuse.js'
import { AgentDispatchSkipped } from './errors.js'

const HISTORY_LIMIT = 20

export interface DispatchAgentArgs {
  conversationId: string
  clinicId: string
  /** The inbound message that triggered dispatch — used for logs/tracing only. */
  messageId: string
  supabase: SupabaseClient
}

export interface DispatchResult {
  /** Id of the AI-generated message inserted into the outbox. */
  messageId: string
  traceId: string | null
  tokensIn: number
  tokensOut: number
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Loads the conversation, the published agent_config, the last 20 messages,
 * generates a reply via the Mastra agent, and inserts the response into the
 * outbox (outbox_status='pending') for the CHAT-2 worker to send.
 *
 * Skips (throws AgentDispatchSkipped) when:
 *   - conversation.state !== 'ai_handling' — atendente paused / resolved / etc.
 *   - no published agent_config for the clinic
 *
 * Throws (caller's Inngest worker retries):
 *   - cross-tenant violation (defense in depth — adapter already filters)
 *   - LLM errors (rate limit, timeout)
 *   - DB errors on insert
 */
export async function dispatchAgent(args: DispatchAgentArgs): Promise<DispatchResult> {
  const { supabase, conversationId, clinicId } = args

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

  // 2. Load the active published agent_config for this clinic.
  // Filter chain doubles as cross-tenant guard: if a clinic somehow has
  // no published 'agente-principal', we skip rather than fall through.
  const { data: cfg } = await supabase
    .from('agent_configs')
    .select('id, system_prompt, model, temperature, max_tokens, name')
    .eq('clinic_id', clinicId)
    .eq('status', 'published')
    .eq('name', 'agente-principal')
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

  // 4. Construct the agent (model + system prompt loaded inside).
  const { agent } = await createAgent({
    clinicId,
    agentName: 'agente-principal',
    supabase,
  })

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
      },
    },
    async (trace: LangfuseTrace | null): Promise<DispatchResult> => {
      const generation = trace?.generation?.({
        name: 'agent.generate',
        model: cfg.model,
        input: messages,
      }) as { end?: (args: Record<string, unknown>) => void } | undefined

      let result
      try {
        result = await agent.generate(messages)
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
        throw err // Inngest worker handles retry
      }

      const text = (result as { text?: string }).text ?? ''
      const usage = (result as { totalUsage?: { inputTokens?: number; outputTokens?: number } }).totalUsage ?? {}

      // 6. Persist response into outbox.
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

      try {
        trace?.score?.({ name: 'latency_ms', value: Date.now() - start })
      } catch {
        /* swallow */
      }

      return {
        messageId: (msg as { id: string }).id,
        traceId: trace?.id ?? null,
        tokensIn: usage.inputTokens ?? 0,
        tokensOut: usage.outputTokens ?? 0,
      }
    },
  )
}

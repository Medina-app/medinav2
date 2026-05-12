import type { SupabaseClient } from '@supabase/supabase-js'
import { createAgent } from './agent-factory.js'
import { getLangfuseClient, withTrace, type LangfuseTrace } from './langfuse.js'
import { AgentDispatchSkipped } from './errors.js'
import { buildToolsFromConfig } from './tools/build.js'
import type { ToolContext } from './types.js'
import { preFilterMessage } from './guardrails/pre-filter.js'
import { detectUrgency, type LlmClassify } from './guardrails/urgency-detector.js'
import { validateOutput } from './guardrails/post-filter.js'
import { escalateWithGuardrail } from './guardrails/escalate-with-guardrail.js'
import { createHaikuClassifier } from './guardrails/haiku-classifier.js'
import { sanitizeEvidence } from './guardrails/sanitize.js'
import type { EscalatedReason, GuardrailsConfig } from './guardrails/types.js'
import { resolveCalcomConfig, type CalcomClientBuilder } from './calcom-config.js'
import { loadPatientFacts, touchFacts } from './patient-memory/store.js'
import { buildPatientFactsContext } from './patient-memory/context.js'
import { parseAiMemoryConfig, type FactCategory, type PatientFact } from './patient-memory/types.js'

const HISTORY_LIMIT = 20
/** Cap the agent loop. AI-SDK default is 1 (single-shot), which would prevent
 *  the LLM from speaking after a tool call. 5 lets typical "tool→reply" flows
 *  finish (escalate→goodbye, business_hours→answer) without infinite loops. */
const MAX_STEPS = 5

/** AI-5: número máximo de regenerações pós-violação do post-filter.
 *  Total de chamadas do LLM por dispatch = 1 inicial + até MAX_REGENERATIONS.
 *  Após esgotar, dispatcher escala via guardrail com canned response. */
const MAX_REGENERATIONS = 2

export interface DispatchAgentArgs {
  conversationId: string
  clinicId: string
  /** The inbound message that triggered dispatch — used for logs/tracing only. */
  messageId: string
  supabase: SupabaseClient
  /** Optional override; defaults to 'agente-principal' (multi-agent prep). */
  agentName?: string
  /** AI-4: builder pra CalcomClient quando integration encontrada. Tests injetam
   *  mock; produção usa factory que importa CalcomClient de @medina/integrations-calcom.
   *  Undefined → tools Cal.com retornam {ok:false, error:'calcom_not_configured'}. */
  buildCalcomClient?: CalcomClientBuilder
}

export interface DispatchResult {
  /** Id of the AI-generated message inserted into the outbox. Empty when escalate
   *  ran with no goodbye text — nothing was added to the outbox. */
  messageId: string
  traceId: string | null
  tokensIn: number
  tokensOut: number
  /** AI-6: true se este dispatch escalou (urgency / pre-filter / post-filter exhausted /
   *  tool escalate_to_human). Caller (Inngest dispatch-ai-agent) usa pra disparar
   *  extract-patient-facts no fim da conversa. */
  didEscalate: boolean
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ToolCallStep { payload?: { toolName?: string } }
interface ToolResultStep { payload?: { toolName?: string; result?: { ok?: boolean } } }
interface AgentStep {
  toolCalls?: ToolCallStep[]
  toolResults?: ToolResultStep[]
}

/** AI-5: mapeia categoria do post-filter (que usa nomes da defaults) → EscalatedReason
 *  estruturado pra escalate_conversation_with_reason. Mantém invariante: nenhum NULL,
 *  fallback pra 'other' quando categoria custom da clínica. */
function mapViolationCategoryToReason(category: string | undefined): EscalatedReason {
  switch (category) {
    case 'medication_request':
      return 'medication'
    case 'diagnosis_request':
    case 'diagnostic_advice':
      return 'diagnosis'
    case 'symptom_interpretation':
      return 'symptom'
    default:
      return 'other'
  }
}

/** AI-5: opcionalmente instancia Haiku classifier pro urgency-detector camada 2.
 *  Off quando OPENROUTER_API_KEY ausente (test env) ou
 *  GUARDRAIL_HAIKU_FALLBACK='off' (kill switch). */
function maybeHaikuClassifier(): LlmClassify | undefined {
  if (process.env['GUARDRAIL_HAIKU_FALLBACK'] === 'off') return undefined
  if (!process.env['OPENROUTER_API_KEY']) return undefined
  try {
    return createHaikuClassifier()
  } catch {
    return undefined
  }
}

/**
 * Loads the conversation, the published agent_config, the last 20 messages,
 * generates a reply via the Mastra agent, and inserts the response into the
 * outbox (outbox_status='pending') for the CHAT-2 worker to send.
 *
 * AI-5 layered guardrails (in order):
 *   1. Pre-filter (regex sobre user msg) — pula LLM, escala medication/diagnosis/etc.
 *   2. Urgency detector (regex + Haiku fallback) — pula LLM, escala como urgency.
 *      Critical sempre vence pre-filter.
 *   3. Post-filter (regex sobre LLM output) — regenera até 2x; persiste violando → escala.
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
  const { supabase, conversationId, clinicId, agentName = 'agente-principal', buildCalcomClient } = args

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
  // AI-5: SELECT inclui guardrails (jsonb) — defaults aplicam quando '{}'.
  // Issue #21: SELECT inclui kb_similarity_threshold (numeric) — search_kb
  // tool consome via ToolContext.
  const { data: cfg } = await supabase
    .from('agent_configs')
    .select('id, system_prompt, model, temperature, max_tokens, name, tools, guardrails, knowledge_document_ids, kb_similarity_threshold')
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

  const guardrailsConfig: GuardrailsConfig =
    (cfg as { guardrails?: GuardrailsConfig }).guardrails ?? {}
  const lastUserContent =
    messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''

  // ─── AI-6: load patient facts for memory injection ──────────────────────────
  // Reads clinics.metadata->'ai_memory' to decide. Failure to load is
  // non-fatal — memory is best-effort, dispatch must not break if facts
  // table is unreachable or metadata malformed.
  let patientFactsContext = ''
  let loadedFactIds: readonly string[] = []
  if (conv.patient_id) {
    try {
      const { data: clinic } = await supabase
        .from('clinics')
        .select('metadata')
        .eq('id', clinicId)
        .single()
      const memoryConfig = parseAiMemoryConfig(
        (clinic as { metadata?: { ai_memory?: unknown } } | null)?.metadata?.ai_memory,
      )
      if (memoryConfig.enabled && memoryConfig.categories.length > 0) {
        const enabledSet = new Set<FactCategory>(memoryConfig.categories)
        const allFacts = await loadPatientFacts(supabase, clinicId, conv.patient_id)
        const facts: PatientFact[] = allFacts.filter((f) => enabledSet.has(f.category))
        patientFactsContext = buildPatientFactsContext(facts)
        loadedFactIds = facts.map((f) => f.id)
      }
    } catch {
      // Memory load failure must not break dispatch. Silenciado.
    }
  }
  if (patientFactsContext.length > 0) {
    messages.unshift(
      {
        role: 'user',
        content: `[SISTEMA-INTERNO] Você tem memória deste paciente:\n${patientFactsContext}\nUse esses fatos administrativos ao responder, mas NÃO mencione "memória" ou "lembro" — apenas trate o paciente naturalmente.`,
      },
      { role: 'assistant', content: 'Entendido. Vou considerar esses fatos ao responder.' },
    )
  }

  // 4. Build tools bound to this dispatch context, then construct the agent.
  //    knowledge_document_ids is AI-3 wiring: search_kb reads it from ToolContext
  //    to filter pgvector results. Empty array means "all docs" — search_kb
  //    converts that to null document_filter for the RPC.
  const toolNames = (cfg.tools as string[] | null) ?? []
  const knowledgeDocumentIds =
    ((cfg as { knowledge_document_ids?: string[] | null }).knowledge_document_ids ?? []) as readonly string[]
  // Issue #21: PostgREST serializa NUMERIC como string ("0.40"); parseFloat
  // pra propagar pra ToolContext. Fallback 0.4 (mesmo DB default) cobre rows
  // legacy pre-migration 0025.
  const rawThreshold = (cfg as { kb_similarity_threshold?: string | number | null })
    .kb_similarity_threshold
  const kbSimilarityThreshold =
    rawThreshold == null
      ? 0.4
      : typeof rawThreshold === 'number'
        ? rawThreshold
        : parseFloat(rawThreshold)
  // AI-4: lookup Cal.com integration apenas se alguma tool Cal.com aparece em
  // toolNames. Skip lookup pra clinics sem integration (zero overhead). Builder
  // injetável pra testes; produção wireia CalcomClient real em apps/web/lib/inngest.
  const needsCalcom =
    buildCalcomClient !== undefined &&
    toolNames.some((n) =>
      n === 'check_availability' ||
      n === 'confirm_appointment' ||
      n === 'cancel_appointment' ||
      n === 'reschedule_appointment',
    )
  const calcomConfig = needsCalcom ? await resolveCalcomConfig(supabase, clinicId) : null
  const calcomClient =
    calcomConfig && buildCalcomClient ? buildCalcomClient(calcomConfig) : undefined

  const toolCtx: ToolContext = {
    clinicId,
    conversationId,
    supabase,
    knowledgeDocumentIds,
    kbSimilarityThreshold,
    calcomClient,
    calcomDefaultEventTypeId: calcomConfig?.defaultEventTypeId,
  }
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
      const traceForGuardrail = trace as unknown as
        | { span?: (a: Record<string, unknown>) => void }
        | null

      // ─── AI-5 LAYER 1+2: pre-filter + urgency in parallel (BEFORE LLM) ─────
      // Aplicado sobre a última mensagem do paciente — a que disparou este
      // dispatch. Critical de urgency vence pre-filter; ambos pulam o LLM.
      if (lastUserContent.length > 0) {
        const llmClassify = maybeHaikuClassifier()
        const [preFilter, urgency] = await Promise.all([
          Promise.resolve(preFilterMessage(lastUserContent, guardrailsConfig)),
          detectUrgency(lastUserContent, {
            config: guardrailsConfig,
            llmFallbackEnabled: !!llmClassify,
            ...(llmClassify ? { llmClassify } : {}),
          }),
        ])

        // Span informacional pra urgency: emite quando NÃO é low (low é silencio
        // total — caso comum). medium = haiku fallback; critical = escalation.
        if (urgency.level !== 'low') {
          try {
            traceForGuardrail?.span?.({
              name: `guardrail.urgency.${urgency.level}`,
              input: {
                category: urgency.category ?? null,
                evidence: urgency.evidence ?? null,
                source: urgency.source,
              },
            })
          } catch {
            /* swallow */
          }
        }

        // Urgency critical vence pre-filter (risco vital tem prioridade absoluta).
        if (urgency.level === 'critical') {
          // Self-review M1: urgency.evidence ja vem sanitizado pelo
          // urgency-detector quando source='regex'. Quando source='llm',
          // evidence pode ser undefined — fallback usa sanitizeEvidence
          // sobre o conteudo cru pra evitar PII vazar pra reasonText
          // (que vai pra audit_logs.metadata.reason + system message
          // visivel no inbox + Langfuse span).
          const evidenceFallback = sanitizeEvidence(lastUserContent)
          const reasonText = `urgency:${urgency.category ?? 'unknown'} — ${urgency.evidence ?? evidenceFallback}`
          const { cannedMessageId } = await escalateWithGuardrail({
            supabase,
            clinicId,
            conversationId,
            agentConfigId: (cfg as { id: string }).id,
            reasonCategory: 'urgency',
            reasonText,
            trace: traceForGuardrail,
          })
          return {
            messageId: cannedMessageId,
            traceId: trace?.id ?? null,
            tokensIn: 0,
            tokensOut: 0,
            didEscalate: true,
          }
        }

        if (preFilter.matched) {
          try {
            traceForGuardrail?.span?.({
              name: 'guardrail.pre_filter.match',
              input: {
                category: preFilter.category,
                reason: preFilter.reason,
                evidence: preFilter.evidence,
              },
            })
          } catch {
            /* swallow */
          }
          const reasonText = `${preFilter.category}: ${preFilter.evidence}`
          const { cannedMessageId } = await escalateWithGuardrail({
            supabase,
            clinicId,
            conversationId,
            agentConfigId: (cfg as { id: string }).id,
            reasonCategory: preFilter.reason,
            reasonText,
            trace: traceForGuardrail,
          })
          return {
            messageId: cannedMessageId,
            traceId: trace?.id ?? null,
            tokensIn: 0,
            tokensOut: 0,
            didEscalate: true,
          }
        }
      }

      const generation = trace?.generation?.({
        name: 'agent.generate',
        model: cfg.model,
        input: messages,
      }) as { end?: (args: Record<string, unknown>) => void } | undefined

      // FIX #7: pass temperature + maxTokens via Mastra's modelSettings.
      // AI-SDK v5 renamed maxTokens → maxOutputTokens; verified in
      // @mastra/core 1.32.1 agent.types.d.ts (modelSettings: CallSettings).
      // PostgREST serializes `numeric` columns as strings (preserves arbitrary
      // precision), so cfg.temperature comes back as e.g. "0.70". parseFloat
      // converts it before passing to the AI-SDK which expects number.
      // max_tokens is `integer`, returned as native number — no parsing.
      const tempNum = typeof cfg.temperature === 'string'
        ? parseFloat(cfg.temperature)
        : (cfg.temperature as number)
      const generateOpts = {
        maxSteps: MAX_STEPS,
        modelSettings: {
          temperature: tempNum,
          maxOutputTokens: cfg.max_tokens,
        },
      }

      let result
      try {
        result = await agent.generate(messages, generateOpts)
        // AI-6: facts foram consumidos pelo LLM — atualiza last_referenced_at
        // pra prevenir expiry de 6 meses. Fire-and-forget; erros silenciados.
        // Roda APÓS generate succeed pra evitar refresh em vão se LLM falhar.
        if (loadedFactIds.length > 0) {
          void touchFacts(supabase, clinicId, loadedFactIds).catch(() => {})
        }
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

      let text = (result as { text?: string }).text ?? ''
      let usage = (result as { totalUsage?: { inputTokens?: number; outputTokens?: number } })
        .totalUsage ?? {}

      // ─── AI-5 LAYER 3: post-filter on LLM output ────────────────────────────
      // Roda só se LLM produziu texto (escalate via tool já bypassed text
      // empty). Se inválido: regenera com correção (até MAX_REGENERATIONS).
      // Persistente → escala via guardrail com canned response.
      let regenerations = 0
      while (text.trim().length > 0) {
        const validation = validateOutput(text, guardrailsConfig)
        if (validation.valid) break

        try {
          traceForGuardrail?.span?.({
            name: 'guardrail.post_filter.violation',
            input: {
              category: validation.violation?.category ?? 'unknown',
              evidence: validation.violation?.evidence ?? null,
              attempt: regenerations + 1,
            },
          })
        } catch {
          /* swallow */
        }

        if (regenerations >= MAX_REGENERATIONS) {
          // Esgotou retries — escala. Caller (Inngest) NÃO retry porque o
          // estado da conversa já mudou pra waiting_human via RPC.
          const reasonCategory = mapViolationCategoryToReason(validation.violation?.category)
          const reasonText = `post_filter:${validation.violation?.category ?? 'unknown'}: ${validation.violation?.evidence ?? '<no evidence>'}`
          const { cannedMessageId } = await escalateWithGuardrail({
            supabase,
            clinicId,
            conversationId,
            agentConfigId: (cfg as { id: string }).id,
            reasonCategory,
            reasonText,
            trace: traceForGuardrail,
          })
          return {
            messageId: cannedMessageId,
            traceId: trace?.id ?? null,
            tokensIn: usage.inputTokens ?? 0,
            tokensOut: usage.outputTokens ?? 0,
            didEscalate: true,
          }
        }

        regenerations++
        // Regenera com correção: assistant + user message interna instruindo o
        // LLM a reescrever sem violação. Mastra trata role='user' como mensagem
        // do paciente; system message embedded é o melhor proxy via abstração
        // atual.
        const correction: ChatMessage = {
          role: 'user',
          content: `[SISTEMA-INTERNO] Sua resposta anterior violou a política da clínica (categoria: ${validation.violation?.category}). Reescreva como secretária — sem diagnóstico, sem indicar medicação. Se o paciente realmente precisa disso, NÃO tente responder; apenas avise que vai transferir pra atendente humano.`,
        }
        const result2 = await agent.generate(
          [...messages, { role: 'assistant' as const, content: text }, correction],
          generateOpts,
        )
        text = (result2 as { text?: string }).text ?? ''
        usage =
          (result2 as { totalUsage?: { inputTokens?: number; outputTokens?: number } })
            .totalUsage ?? usage
      }

      // 6. Detect tool-call escalation. PR-D #13 fix: olhar pra toolResult.ok,
      //    não toolCall mero. Antes, escalatedByStepShape flippava em qualquer
      //    chamada de escalate_to_human — incluindo casos { ok:false }
      //    (já-transferida, race) que NÃO devem registrar didEscalate=true.
      //
      // AI-6 hotfix manteve fallback via state transition do DB pra cobrir
      // shape variance do Mastra/AI-SDK e o path guardrail-driven (dispatcher
      // chama escalate_conversation_with_reason direto, sem passar pela tool).
      const steps = ((result as { steps?: AgentStep[] }).steps) ?? []
      const escalatedByToolResult = steps.some((s) =>
        (s.toolResults ?? []).some((tr) => {
          if (tr.payload?.toolName !== 'escalate_to_human') return false
          return tr.payload?.result?.ok === true
        }),
      )
      let escalated = escalatedByToolResult
      if (!escalated) {
        const { data: convAfter } = await supabase
          .from('conversations')
          .select('state')
          .eq('id', conversationId)
          .single()
        const stateAfter = (convAfter as { state?: string } | null)?.state
        escalated = stateAfter === 'waiting_human' || stateAfter === 'resolved'
      }

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
        didEscalate: escalated,
      }
    },
  )
}

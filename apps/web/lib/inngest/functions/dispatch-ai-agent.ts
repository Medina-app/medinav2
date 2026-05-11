import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CalcomClient } from '@medina/integrations-calcom/client';
import {
  dispatchAgent,
  AgentDispatchSkipped,
  type DispatchAgentArgs,
  type DispatchResult,
} from '@medina/ai';
import { inngest } from '@/lib/inngest/client';

// ─── Types ───────────────────────────────────────────────────────────────

export type DispatchAiAgentEvent = {
  data: {
    messageId: string;
    conversationId: string;
    clinicId: string;
  };
};

export type DispatchAiAgentDeps = {
  dispatchAgent: (args: DispatchAgentArgs) => Promise<DispatchResult>;
};

export type StepLike = {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  sendEvent: (id: string, event: { name: string; data: Record<string, unknown> }) => Promise<unknown>;
};

export type DispatchAiAgentResult =
  | { messageId: string; tokensIn: number; tokensOut: number }
  | { skipped: 'state_not_ai_handling' | 'no_agent_config' | 'cross_tenant' };

// Inngest emits `inngest/function.failed` after all configured retries are
// exhausted. The shape mirrors what's used in process-outbound-message.ts.
export type OnDispatchAiAgentFailureEvent = {
  data: {
    function_id?: string;
    event: { data: { messageId: string; conversationId: string; clinicId: string } };
    error: { message: string };
    attempts?: number;
  };
};

export type PersistAiFailureArgs = {
  conversationId: string;
  clinicId: string;
  errorMessage: string;
  retryCount: number;
};

export type OnDispatchAiAgentFailureDeps = {
  persistAiFailure: (args: PersistAiFailureArgs) => Promise<void>;
};

const FAILURE_TRUNCATE = 500;
// Default mirrors `retries: 2` on the dispatch-ai-agent function below.
const DEFAULT_RETRY_COUNT = 2;

// ─── Handler (testable) ──────────────────────────────────────────────────

export async function dispatchAiAgentHandler(
  event: DispatchAiAgentEvent,
  step: StepLike,
  deps: DispatchAiAgentDeps,
): Promise<DispatchAiAgentResult> {
  const { messageId, conversationId, clinicId } = event.data;

  let result: DispatchResult;
  try {
    result = await step.run('dispatch-agent', () =>
      // Inject the supabase admin client at the wiring layer; the testable
      // handler stays pure and only receives the dispatch fn.
      deps.dispatchAgent({
        messageId,
        conversationId,
        clinicId,
        supabase: undefined as unknown as SupabaseClient,
      }),
    );
  } catch (err) {
    // AgentDispatchSkipped = expected no-op (state not ai_handling, no config, etc).
    // Treat as success so Inngest does NOT retry — there's nothing to fix.
    if (err instanceof AgentDispatchSkipped) {
      return { skipped: err.reason };
    }
    throw err; // Real error: LLM rate limit, DB error → Inngest retries.
  }

  await step.sendEvent('queue-outbound', {
    name: 'chat/message.outbound',
    data: { messageId: result.messageId },
  });

  // AI-6: ao escalar (urgency / pre-filter / post-filter exhausted / tool
  // escalate_to_human), conversa transiciona pra waiting_human. Dispara
  // extração de patient facts a partir do histórico. Worker é idempotente
  // via UNIQUE INDEX em patient_facts(clinic_id, patient_id, category, key).
  if (result.didEscalate) {
    await step.sendEvent('request-patient-facts-extract', {
      name: 'ai/patient-facts.extract-requested',
      data: { conversationId, clinicId, trigger: 'escalated' },
    });
  }

  return {
    messageId: result.messageId,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  };
}

// Mirrors apps/web/lib/inngest/functions/process-outbound-message.ts:107-120.
// Inngest emits inngest/function.failed AFTER all retries are exhausted; we
// use it to surface the AI failure in the inbox (atendente sees ⚠️) instead
// of leaving the conversation in ai_handling with no AI reply.
export async function onDispatchAiAgentFailureHandler(
  event: OnDispatchAiAgentFailureEvent,
  deps: OnDispatchAiAgentFailureDeps,
): Promise<void> {
  const { conversationId, clinicId } = event.data.event.data;
  const truncated = event.data.error.message.slice(0, FAILURE_TRUNCATE);
  const retryCount = event.data.attempts ?? DEFAULT_RETRY_COUNT;
  await deps.persistAiFailure({ conversationId, clinicId, errorMessage: truncated, retryCount });
}

// ─── Production wiring ───────────────────────────────────────────────────

function makeAdminSupabase(): SupabaseClient {
  return createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function makeDefaultDeps(): DispatchAiAgentDeps {
  // Each invocation gets its own Supabase admin client to avoid sharing
  // across requests (unlikely to matter in practice but cheap insurance).
  // AI-4: buildCalcomClient instancia CalcomClient quando integration ativa
  // existe pra clinic. Lazy import pra evitar penalty de boot pra clinics
  // sem Cal.com configurado.
  return {
    dispatchAgent: (args) =>
      dispatchAgent({
        ...args,
        supabase: makeAdminSupabase(),
        // AI-4: instancia CalcomClient quando dispatcher resolve integration
        // ativa pra clinic. Sem integration → callback nem é chamado.
        buildCalcomClient: (cfg) =>
          new CalcomClient({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }),
      }),
  };
}

const AI_FAILURE_PLACEHOLDER = '[Falha na resposta da IA — atendente, retome esta conversa]';

export function makeAiFailureRepo(sb: SupabaseClient): OnDispatchAiAgentFailureDeps {
  return {
    async persistAiFailure(args: PersistAiFailureArgs): Promise<void> {
      // INSERT (not UPDATE): the dispatcher only writes the response row on
      // success, so on failure no row exists yet. We write a placeholder
      // here so the atendente can see something happened. agent_config_id
      // stays NULL — validate_message_agent_config_clinic (0009_agent_ai.sql:209)
      // skips the FK check when NULL. Per-attempt Langfuse traces still
      // carry the cfg id, so auditability lives there.
      const { error } = await sb.from('messages').insert({
        clinic_id: args.clinicId,
        conversation_id: args.conversationId,
        direction: 'outbound',
        sender_type: 'ai',
        sender_user_id: null,
        content_type: 'text',
        content: AI_FAILURE_PLACEHOLDER,
        external_id: null,
        delivery_status: 'failed',
        outbox_status: 'failed',
        delivery_error: args.errorMessage,
        last_error_at: new Date().toISOString(),
        retry_count: args.retryCount,
        agent_config_id: null,
      });
      if (error) throw new Error(`persist-ai-failure failed: ${error.message}`);
    },
  };
}

function makeDefaultFailureDeps(): OnDispatchAiAgentFailureDeps {
  return makeAiFailureRepo(makeAdminSupabase());
}

// ─── Inngest wiring ──────────────────────────────────────────────────────

export const dispatchAiAgent = inngest.createFunction(
  {
    id: 'dispatch-ai-agent',
    retries: 2,
    triggers: [{ event: 'ai/message.received' }],
  },
  async ({ event, step }) =>
    dispatchAiAgentHandler(
      event as unknown as DispatchAiAgentEvent,
      step as unknown as StepLike,
      makeDefaultDeps(),
    ),
);

export const onDispatchAiAgentFailure = inngest.createFunction(
  {
    id: 'dispatch-ai-agent-on-failure',
    triggers: [{ event: 'inngest/function.failed' }],
  },
  async ({ event }) => {
    const e = event as unknown as OnDispatchAiAgentFailureEvent;
    // Filter at the handler boundary: only act on failures of dispatch-ai-agent
    // so we don't double-handle other workers' failures.
    if (e.data.function_id !== 'dispatch-ai-agent') return;
    return onDispatchAiAgentFailureHandler(e, makeDefaultFailureDeps());
  },
);

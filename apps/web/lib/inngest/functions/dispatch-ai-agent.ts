import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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

  return {
    messageId: result.messageId,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  };
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
  return {
    dispatchAgent: (args) => dispatchAgent({ ...args, supabase: makeAdminSupabase() }),
  };
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

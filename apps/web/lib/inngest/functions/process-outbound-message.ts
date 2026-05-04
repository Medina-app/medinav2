import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { inngest } from '@/lib/inngest/client';

// ─── Types ───────────────────────────────────────────────────────────────

export type OutboundContext = {
  integrationId: string;
  phoneNumberId: string;
  toPhone: string;
  content: string;
};

export type OutboxContextResult =
  | { alreadySent: true }
  | { alreadySent: false; ctx: OutboundContext };

export type OutboxRepo = {
  loadContext: (messageId: string) => Promise<OutboxContextResult>;
  markProcessing: (messageId: string) => Promise<void>;
  persistSuccess: (messageId: string, wamid: string) => Promise<void>;
  persistFailure: (messageId: string, errorMessage: string, retryCount: number) => Promise<void>;
};

export type FetchKapsoFn = (params: {
  apiKey: string;
  phoneNumberId: string;
  toPhone: string;
  content: string;
}) => Promise<{ wamid: string }>;

export type ProcessOutboundDeps = {
  repo: OutboxRepo;
  decryptCredential: (integrationId: string) => Promise<{ api_key: string }>;
  fetchKapso: FetchKapsoFn;
};

export type OnFailureDeps = {
  persistFailure: OutboxRepo['persistFailure'];
};

// Test-friendly step abstraction: in production, Inngest provides a richer
// step API (sleep, waitForEvent, etc); we only need step.run.
export type StepLike = {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
};

export type ProcessOutboundEvent = {
  data: { messageId: string; clinicId: string; conversationId: string };
};

export type OnFailureEvent = {
  data: {
    event: { data: { messageId: string; clinicId: string; conversationId: string } };
    error: { message: string };
    attempts?: number;
  };
};

// ─── Handlers (testable) ─────────────────────────────────────────────────

export async function processOutboundMessageHandler(
  event: ProcessOutboundEvent,
  step: StepLike,
  deps: ProcessOutboundDeps,
): Promise<{ sent: true } | { skipped: 'already_sent' }> {
  const { messageId } = event.data;

  const ctxResult = await step.run('load-context', () => deps.repo.loadContext(messageId));
  if (ctxResult.alreadySent) return { skipped: 'already_sent' };
  const { ctx } = ctxResult;

  await step.run('mark-processing', () => deps.repo.markProcessing(messageId));

  const creds = await step.run('decrypt-credential', () =>
    deps.decryptCredential(ctx.integrationId),
  );

  const { wamid } = await step.run('post-to-kapso', () =>
    deps.fetchKapso({
      apiKey: creds.api_key,
      phoneNumberId: ctx.phoneNumberId,
      toPhone: ctx.toPhone,
      content: ctx.content,
    }),
  );

  await step.run('persist-success', () => deps.repo.persistSuccess(messageId, wamid));

  return { sent: true };
}

const FAILURE_TRUNCATE = 500;

export async function onProcessOutboundFailureHandler(
  event: OnFailureEvent,
  deps: OnFailureDeps,
): Promise<void> {
  const { messageId } = event.data.event.data;
  const truncated = event.data.error.message.slice(0, FAILURE_TRUNCATE);
  const retryCount = event.data.attempts ?? 5;
  await deps.persistFailure(messageId, truncated, retryCount);
}

// ─── Production wiring ───────────────────────────────────────────────────

function makeAdminSupabase(): SupabaseClient {
  return createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export function makeOutboxRepo(sb: SupabaseClient): OutboxRepo {
  return {
    async loadContext(messageId) {
      const { data: msg, error: msgErr } = await sb
        .from('messages')
        .select('id, outbox_status, content, conversation_id')
        .eq('id', messageId)
        .maybeSingle();
      if (msgErr) throw new Error(`message lookup failed: ${msgErr.message}`);
      if (!msg) throw new Error(`message ${messageId} not found`);
      if (msg.outbox_status === 'sent') return { alreadySent: true };

      const { data: conv, error: convErr } = await sb
        .from('conversations')
        .select('integration_id, external_id')
        .eq('id', msg.conversation_id as string)
        .maybeSingle();
      if (convErr) throw new Error(`conversation lookup failed: ${convErr.message}`);
      if (!conv) throw new Error(`conversation ${msg.conversation_id} not found`);

      const { data: integ, error: integErr } = await sb
        .from('clinic_integrations')
        .select('id, status, config')
        .eq('id', conv.integration_id as string)
        .is('deleted_at', null)
        .maybeSingle();
      if (integErr) throw new Error(`integration lookup failed: ${integErr.message}`);
      if (!integ) throw new Error(`integration not found`);
      if (integ.status !== 'active') throw new Error(`integration not active (status=${integ.status})`);

      const cfg = (integ.config ?? {}) as Record<string, unknown>;
      const phoneNumberId = cfg['phone_number_id'] as string | undefined;
      if (!phoneNumberId) throw new Error('phone_number_id not captured');

      return {
        alreadySent: false,
        ctx: {
          integrationId: integ.id as string,
          phoneNumberId,
          toPhone: conv.external_id as string,
          content: (msg.content as string | null) ?? '',
        },
      };
    },

    async markProcessing(messageId) {
      const { error } = await sb
        .from('messages')
        .update({ outbox_status: 'processing' })
        .eq('id', messageId);
      if (error) throw new Error(`mark-processing failed: ${error.message}`);
    },

    async persistSuccess(messageId, wamid) {
      const { error } = await sb
        .from('messages')
        .update({ outbox_status: 'sent', delivery_status: 'sent', external_id: wamid })
        .eq('id', messageId);
      if (error) throw new Error(`persist-success failed: ${error.message}`);
    },

    async persistFailure(messageId, errorMessage, retryCount) {
      const { error } = await sb
        .from('messages')
        .update({
          outbox_status: 'failed',
          delivery_error: errorMessage,
          last_error_at: new Date().toISOString(),
          retry_count: retryCount,
        })
        .eq('id', messageId);
      if (error) throw new Error(`persist-failure failed: ${error.message}`);
    },
  };
}

async function decryptCredentialReal(
  sb: SupabaseClient,
  integrationId: string,
): Promise<{ api_key: string }> {
  const { data, error } = await sb.rpc('get_integration_credential', {
    p_integration_id: integrationId,
  });
  if (error) throw new Error(`credential decrypt failed: ${error.message}`);
  if (!data) throw new Error('credential decrypt returned no data');
  return JSON.parse(data as string) as { api_key: string };
}

async function fetchKapsoReal(params: {
  apiKey: string;
  phoneNumberId: string;
  toPhone: string;
  content: string;
}): Promise<{ wamid: string }> {
  const res = await fetch(
    `https://api.kapso.ai/meta/whatsapp/v24.0/${params.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: { 'X-API-Key': params.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: params.toPhone,
        type: 'text',
        text: { body: params.content },
      }),
    },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`kapso ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = (await res.json().catch(() => null)) as {
    messages?: Array<{ id: string }>;
  } | null;
  const wamid = json?.messages?.[0]?.id;
  if (!wamid) throw new Error('kapso returned no message id');
  return { wamid };
}

function makeDefaultDeps(): ProcessOutboundDeps {
  const sb = makeAdminSupabase();
  return {
    repo: makeOutboxRepo(sb),
    decryptCredential: (integrationId) => decryptCredentialReal(sb, integrationId),
    fetchKapso: fetchKapsoReal,
  };
}

function makeDefaultOnFailureDeps(): OnFailureDeps {
  const sb = makeAdminSupabase();
  const repo = makeOutboxRepo(sb);
  return { persistFailure: repo.persistFailure };
}

// ─── Inngest wiring ──────────────────────────────────────────────────────

export const processOutboundMessage = inngest.createFunction(
  {
    id: 'process-outbound-message',
    retries: 5,
    triggers: [{ event: 'chat/message.outbound' }],
  },
  async ({ event, step }) =>
    processOutboundMessageHandler(
      event as unknown as ProcessOutboundEvent,
      step as StepLike,
      makeDefaultDeps(),
    ),
);

export const onProcessOutboundFailure = inngest.createFunction(
  {
    id: 'process-outbound-on-failure',
    triggers: [{ event: 'inngest/function.failed' }],
  },
  async ({ event }) => {
    const e = event as unknown as OnFailureEvent;
    // Filter at the handler level: only act on failures of the outbound worker.
    if (
      (event as unknown as { data: { function_id?: string } }).data.function_id !==
      'process-outbound-message'
    ) {
      return;
    }
    return onProcessOutboundFailureHandler(e, makeDefaultOnFailureDeps());
  },
);

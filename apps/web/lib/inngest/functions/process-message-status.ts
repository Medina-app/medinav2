import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  updateMessageDeliveryStatus,
  type StatusUpdateEvent,
  type UpdateDeliveryStatusResult,
} from '@medina/chat';
import {
  buildConversationChannel,
  publishToChannelFireAndForget,
  type EventPayload,
  type PublisherDeps,
} from '@medina/realtime';
import { inngest } from '@/lib/inngest/client';

// ─── Types ───────────────────────────────────────────────────────────────

export type ProcessMessageStatusEvent = {
  data: {
    clinicId: string;
    externalMessageId: string;
    status: StatusUpdateEvent['status'];
    deliveryError: string | undefined;
  };
};

export type ProcessMessageStatusDeps = {
  updateDeliveryStatus: (
    clinicId: string,
    evt: StatusUpdateEvent,
  ) => Promise<UpdateDeliveryStatusResult>;
  publish?: (channel: string, payload: EventPayload) => void;
};

export type StepLike = {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
};

// ─── Handler (testable) ──────────────────────────────────────────────────

export async function processMessageStatusHandler(
  event: ProcessMessageStatusEvent,
  step: StepLike,
  deps: ProcessMessageStatusDeps,
): Promise<UpdateDeliveryStatusResult> {
  const { clinicId, externalMessageId, status, deliveryError } = event.data;
  const result = await step.run('update-delivery-status', () =>
    deps.updateDeliveryStatus(clinicId, {
      kind: 'status_update',
      externalMessageId,
      status,
      deliveryError,
    }),
  );
  if (result.updated) {
    deps.publish?.(buildConversationChannel(clinicId, result.conversationId), {
      type: 'message.updated',
      conversationId: result.conversationId,
      messageId: result.messageId,
    });
  }
  return result;
}

// ─── Production wiring ───────────────────────────────────────────────────

function makeAdminSupabase(): SupabaseClient {
  return createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function getPublisherDeps(): PublisherDeps {
  return {
    apiUrl: process.env['CENTRIFUGO_API_URL'] ?? '',
    apiKey: process.env['CENTRIFUGO_API_KEY'] ?? '',
  };
}

function makeDefaultDeps(): ProcessMessageStatusDeps {
  const sb = makeAdminSupabase();
  const pub = getPublisherDeps();
  return {
    updateDeliveryStatus: (clinicId, evt) => updateMessageDeliveryStatus(sb, clinicId, evt),
    publish: (channel, payload) => publishToChannelFireAndForget(pub, channel, payload),
  };
}

// ─── Inngest wiring ──────────────────────────────────────────────────────

export const processMessageStatus = inngest.createFunction(
  {
    id: 'process-message-status',
    retries: 3,
    triggers: [{ event: 'chat/message.status_update' }],
  },
  async ({ event, step }) =>
    processMessageStatusHandler(
      event as unknown as ProcessMessageStatusEvent,
      step as StepLike,
      makeDefaultDeps(),
    ),
);

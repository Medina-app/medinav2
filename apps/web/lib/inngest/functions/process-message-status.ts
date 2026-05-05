import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { updateMessageDeliveryStatus, type StatusUpdateEvent } from '@medina/chat';
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
  ) => Promise<{ updated: boolean }>;
};

export type StepLike = {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
};

// ─── Handler (testable) ──────────────────────────────────────────────────

export async function processMessageStatusHandler(
  event: ProcessMessageStatusEvent,
  step: StepLike,
  deps: ProcessMessageStatusDeps,
): Promise<{ updated: boolean }> {
  const { clinicId, externalMessageId, status, deliveryError } = event.data;
  return step.run('update-delivery-status', () =>
    deps.updateDeliveryStatus(clinicId, {
      kind: 'status_update',
      externalMessageId,
      status,
      deliveryError,
    }),
  );
}

// ─── Production wiring ───────────────────────────────────────────────────

function makeAdminSupabase(): SupabaseClient {
  return createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function makeDefaultDeps(): ProcessMessageStatusDeps {
  const sb = makeAdminSupabase();
  return {
    updateDeliveryStatus: (clinicId, evt) => updateMessageDeliveryStatus(sb, clinicId, evt),
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

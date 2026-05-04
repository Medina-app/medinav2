import type { SupabaseClient } from '@supabase/supabase-js';
import { addMessage } from './conversations';

export type InngestOutboundEvent = {
  name: 'chat/message.outbound';
  id: string;
  data: {
    messageId: string;
    clinicId: string;
    conversationId: string;
  };
};

export type InngestSendFn = (event: InngestOutboundEvent) => Promise<unknown>;

export type QueueOutboundMessageArgs = {
  clinicId: string;
  conversationId: string;
  content: string;
  senderUserId: string | null;
};

/**
 * Inserts an outbound text message in the queue (delivery_status='pending',
 * outbox_status='pending') and dispatches a deterministic Inngest event so
 * the worker picks it up. Returns once the row is committed and the event
 * is acknowledged by Inngest — no Kapso round-trip happens here.
 *
 * Idempotency: the event id is `outbound:${messageId}`, so an accidental
 * double-dispatch (rare; the message id is a fresh UUID per call) would be
 * deduplicated by Inngest's internal event-id index.
 *
 * Error semantics: if `inngestSend` rejects, the message row stays in the
 * DB with outbox_status='pending'. The error is rethrown so the caller
 * surfaces it; a future cron sweep over rows stuck in 'pending' beyond a
 * threshold can re-dispatch them.
 */
export async function queueOutboundMessage(
  sb: SupabaseClient,
  inngestSend: InngestSendFn,
  a: QueueOutboundMessageArgs,
): Promise<{ messageId: string }> {
  const { message } = await addMessage(sb, {
    clinicId: a.clinicId,
    conversationId: a.conversationId,
    direction: 'outbound',
    senderType: 'human',
    senderUserId: a.senderUserId,
    contentType: 'text',
    content: a.content,
    externalId: null,
    deliveryStatus: 'pending',
    outboxStatus: 'pending',
  });

  await inngestSend({
    name: 'chat/message.outbound',
    id: `outbound:${message.id}`,
    data: {
      messageId: message.id,
      clinicId: a.clinicId,
      conversationId: a.conversationId,
    },
  });

  return { messageId: message.id };
}

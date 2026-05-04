import type { Message } from '@medina/chat';

/**
 * Visual state derived from a message's outbox + delivery status pair.
 *
 * Decision tree (in priority order):
 *   1. failed (either side) → 'failed' with the error message.
 *      Failure UI must always win because user action is required.
 *   2. outbox_status='pending' → 'pending' (queued, not yet picked up by worker)
 *   3. outbox_status='processing' → 'processing' (worker started)
 *   4. delivery_status takes over for the WhatsApp side: read > delivered > sent.
 *   5. fallback (legacy CHAT-1 rows with outbox_status NULL but
 *      delivery_status='pending') → 'pending'.
 */
export type MessageVisualState =
  | { kind: 'pending' }
  | { kind: 'processing' }
  | { kind: 'sent' }
  | { kind: 'delivered' }
  | { kind: 'read' }
  | { kind: 'failed'; error: string | null };

export function getMessageVisualState(m: Message): MessageVisualState {
  if (m.outboxStatus === 'failed' || m.deliveryStatus === 'failed') {
    return { kind: 'failed', error: m.deliveryError ?? null };
  }
  if (m.outboxStatus === 'pending') return { kind: 'pending' };
  if (m.outboxStatus === 'processing') return { kind: 'processing' };
  if (m.deliveryStatus === 'read') return { kind: 'read' };
  if (m.deliveryStatus === 'delivered') return { kind: 'delivered' };
  if (m.deliveryStatus === 'sent') return { kind: 'sent' };
  return { kind: 'pending' };
}

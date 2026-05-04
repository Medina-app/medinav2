import type { Message } from '@medina/chat';

/**
 * Decides whether the inbox conversation panel should be polling for
 * updates. Returns true when at least one message is in a non-terminal
 * outbox/delivery state — i.e. the user might see something change in the
 * next few seconds (worker progress, callback arrival, retry).
 *
 * Active states:
 *   - outbox_status='pending'      (queued, worker hasn't picked up)
 *   - outbox_status='processing'   (worker started, awaiting Kapso ACK)
 *   - outbox_status='failed'       (worker exhausted retries; user may click Retentar)
 *   - delivery_status='failed'     (Kapso callback reported delivery failure)
 *
 * Terminal non-failed states stop polling: 'sent', 'delivered', 'read'.
 *
 * Inbound messages naturally return false — adapter sets
 * outbox_status=null + delivery_status='delivered'.
 */
export function hasActiveMessages(messages: Message[]): boolean {
  return messages.some(
    (m) =>
      m.outboxStatus === 'pending' ||
      m.outboxStatus === 'processing' ||
      m.outboxStatus === 'failed' ||
      m.deliveryStatus === 'failed',
  );
}

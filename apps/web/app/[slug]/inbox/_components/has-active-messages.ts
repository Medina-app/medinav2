import type { Message } from '@medina/chat';

/**
 * Decides whether the inbox conversation panel should be polling for
 * updates. Returns true when at least one message is in a non-terminal
 * outbox/delivery state — i.e. the user might see something change in the
 * next few seconds (worker progress, callback arrival).
 *
 * Active states:
 *   - outbox_status in ('pending', 'processing')  (worker still working)
 *   - outbox_status='sent' AND delivery_status NOT IN ('delivered','read','failed')
 *     (worker done, awaiting carrier delivery callback)
 *
 * Terminal states stop polling:
 *   - outbox_status='failed'         (worker exhausted retries; user clicks Retentar)
 *   - delivery_status='delivered'/'read'  (success)
 *   - delivery_status='failed'       (terminal carrier failure)
 *
 * Inbound messages naturally return false — adapter sets
 * outbox_status=null + delivery_status='delivered'.
 */
export function hasActiveMessages(messages: Message[]): boolean {
  return messages.some((m) => {
    if (m.outboxStatus === 'pending' || m.outboxStatus === 'processing') return true;
    if (m.outboxStatus === 'sent') {
      return (
        m.deliveryStatus !== 'delivered' &&
        m.deliveryStatus !== 'read' &&
        m.deliveryStatus !== 'failed'
      );
    }
    return false;
  });
}

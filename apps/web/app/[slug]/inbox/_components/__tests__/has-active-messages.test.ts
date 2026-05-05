import { describe, expect, it } from 'vitest';
import type { Message } from '@medina/chat';
import { hasActiveMessages } from '../has-active-messages';

function msg(overrides: Partial<Message>): Message {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    clinicId: 'clinic-1',
    direction: 'outbound',
    senderType: 'human',
    senderUserId: null,
    contentType: 'text',
    content: 'oi',
    mediaUrl: null,
    mediaMetadata: null,
    templateName: null,
    templateVariables: null,
    externalId: null,
    deliveryStatus: 'sent',
    deliveryError: null,
    lastErrorAt: null,
    outboxStatus: 'sent',
    retryCount: 0,
    aiMetadata: null,
    agentConfigId: null,
    inReplyTo: null,
    createdAt: new Date(),
    ...overrides,
  } as Message;
}

describe('hasActiveMessages', () => {
  it('returns false for empty list (polling never starts)', () => {
    expect(hasActiveMessages([])).toBe(false);
  });

  it('returns false when all messages reached terminal success (delivered/read)', () => {
    const msgs = [
      msg({ id: 'a', outboxStatus: 'sent', deliveryStatus: 'delivered' }),
      msg({ id: 'b', outboxStatus: 'sent', deliveryStatus: 'read' }),
    ];
    expect(hasActiveMessages(msgs)).toBe(false);
  });

  it('returns true when outbox_status=sent and delivery_status is still in flight', () => {
    // Worker handed off to carrier (wamid acquired) but no delivered/read
    // callback yet — keep polling so the UI flips ✓ → ✓✓ live.
    const msgs = [msg({ outboxStatus: 'sent', deliveryStatus: 'sent' })];
    expect(hasActiveMessages(msgs)).toBe(true);
  });

  it('returns true when ANY message has outbox_status=pending', () => {
    const msgs = [
      msg({ id: 'a', outboxStatus: 'sent', deliveryStatus: 'delivered' }),
      msg({ id: 'b', outboxStatus: 'pending', deliveryStatus: 'pending' }),
    ];
    expect(hasActiveMessages(msgs)).toBe(true);
  });

  it('returns true when ANY message has outbox_status=processing', () => {
    const msgs = [msg({ outboxStatus: 'processing', deliveryStatus: 'pending' })];
    expect(hasActiveMessages(msgs)).toBe(true);
  });

  it('returns false when outbox_status=failed (terminal — user clicks Retentar, no polling)', () => {
    const msgs = [msg({ outboxStatus: 'failed', deliveryStatus: 'pending' })];
    expect(hasActiveMessages(msgs)).toBe(false);
  });

  it('returns false when delivery_status=failed (terminal carrier failure, no polling)', () => {
    const msgs = [msg({ outboxStatus: 'sent', deliveryStatus: 'failed' })];
    expect(hasActiveMessages(msgs)).toBe(false);
  });

  it('inbound messages with delivery_status=delivered do not trigger polling', () => {
    // Adapter sets outbox_status=null + delivery_status='delivered' for inbound.
    const msgs = [
      msg({
        direction: 'inbound',
        senderType: 'patient',
        outboxStatus: null,
        deliveryStatus: 'delivered',
      }),
    ];
    expect(hasActiveMessages(msgs)).toBe(false);
  });

  it('legacy CHAT-1 outbound row (outbox_status=null, delivery_status=sent) does not trigger polling', () => {
    // Pre-CHAT-2 outbound rows have outbox_status NULL because they were
    // INSERTed synchronously before the outbox column was used.
    const msgs = [msg({ outboxStatus: null, deliveryStatus: 'sent' })];
    expect(hasActiveMessages(msgs)).toBe(false);
  });
});

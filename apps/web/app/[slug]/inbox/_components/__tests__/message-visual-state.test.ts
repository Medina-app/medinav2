import { describe, expect, it } from 'vitest';
import type { Message } from '@medina/chat';
import { getMessageVisualState } from '../message-visual-state';

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
    deliveryStatus: 'pending',
    deliveryError: null,
    lastErrorAt: null,
    outboxStatus: null,
    retryCount: 0,
    aiMetadata: null,
    agentConfigId: null,
    inReplyTo: null,
    createdAt: new Date(),
    ...overrides,
  } as Message;
}

describe('getMessageVisualState', () => {
  it('outbox_status=pending → pending', () => {
    expect(getMessageVisualState(msg({ outboxStatus: 'pending' }))).toEqual({ kind: 'pending' });
  });

  it('outbox_status=processing → processing', () => {
    expect(getMessageVisualState(msg({ outboxStatus: 'processing' }))).toEqual({ kind: 'processing' });
  });

  it('outbox_status=sent + delivery_status=sent → sent', () => {
    const r = getMessageVisualState(msg({ outboxStatus: 'sent', deliveryStatus: 'sent' }));
    expect(r).toEqual({ kind: 'sent' });
  });

  it('delivery_status=delivered overrides sent → delivered (single check → double check)', () => {
    const r = getMessageVisualState(msg({ outboxStatus: 'sent', deliveryStatus: 'delivered' }));
    expect(r).toEqual({ kind: 'delivered' });
  });

  it('delivery_status=read → read (future blue double check)', () => {
    const r = getMessageVisualState(msg({ outboxStatus: 'sent', deliveryStatus: 'read' }));
    expect(r).toEqual({ kind: 'read' });
  });

  it('outbox_status=failed → failed with deliveryError carried through', () => {
    const r = getMessageVisualState(msg({
      outboxStatus: 'failed',
      deliveryStatus: 'pending',
      deliveryError: 'kapso 503',
    }));
    expect(r).toEqual({ kind: 'failed', error: 'kapso 503' });
  });

  it('delivery_status=failed → failed (callback failure path)', () => {
    const r = getMessageVisualState(msg({
      outboxStatus: 'sent',
      deliveryStatus: 'failed',
      deliveryError: 're-engagement window expired',
    }));
    expect(r).toEqual({ kind: 'failed', error: 're-engagement window expired' });
  });

  it('failed with null deliveryError → failed with error=null', () => {
    const r = getMessageVisualState(msg({ outboxStatus: 'failed', deliveryError: null }));
    expect(r).toEqual({ kind: 'failed', error: null });
  });

  it('legacy CHAT-1 row (outbox_status=null, delivery_status=sent) → sent', () => {
    // Pre-CHAT-2 outbound rows have outbox_status NULL and delivery_status='sent'.
    // Visually treat them like a freshly-confirmed send.
    const r = getMessageVisualState(msg({ outboxStatus: null, deliveryStatus: 'sent' }));
    expect(r).toEqual({ kind: 'sent' });
  });

  it('inbound message with delivery_status=delivered → delivered (no outbox involvement)', () => {
    const r = getMessageVisualState(msg({
      direction: 'inbound',
      outboxStatus: null,
      deliveryStatus: 'delivered',
    }));
    expect(r).toEqual({ kind: 'delivered' });
  });

  it('failed wins over pending on conflicting state', () => {
    // Defensive: if somehow outbox_status='pending' and delivery_status='failed'
    // (weird state, shouldn't happen but worth covering), failure UI takes
    // priority because user needs to act.
    const r = getMessageVisualState(msg({ outboxStatus: 'pending', deliveryStatus: 'failed', deliveryError: 'x' }));
    expect(r).toEqual({ kind: 'failed', error: 'x' });
  });
});

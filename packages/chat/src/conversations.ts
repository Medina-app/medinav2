import type { SupabaseClient } from '@supabase/supabase-js';
import type { Conversation, Message } from '@medina/db';
import type { StatusUpdateEvent } from './types';
import { mapConversation, mapMessage } from './mappers';

export type GetOrCreateConversationArgs = {
  clinicId: string;
  integrationId: string;
  channel: 'whatsapp';
  externalId: string;
  patientId: string | null;
};

/**
 * Idempotent on (clinic_id, integration_id, external_id) thanks to the
 * partial unique index `idx_conversations_clinic_integration_external_unique`.
 * Default state for new conversations is 'waiting_human' so the inbox UI
 * picks them up — agent-driven flows in CHAT-3+ will INSERT with
 * 'ai_handling' instead.
 */
export async function getOrCreateConversation(
  sb: SupabaseClient,
  a: GetOrCreateConversationArgs,
): Promise<{ conversation: Conversation; created: boolean }> {
  const { data: existing, error: selErr } = await sb
    .from('conversations')
    .select('*')
    .eq('clinic_id', a.clinicId)
    .eq('integration_id', a.integrationId)
    .eq('external_id', a.externalId)
    .is('deleted_at', null)
    .maybeSingle();
  if (selErr) throw new Error(`conversation lookup failed: ${selErr.message}`);
  if (existing) return { conversation: mapConversation(existing), created: false };

  const { data: created, error: insErr } = await sb
    .from('conversations')
    .insert({
      clinic_id: a.clinicId,
      integration_id: a.integrationId,
      channel: a.channel,
      external_id: a.externalId,
      patient_id: a.patientId,
      state: 'waiting_human',
    })
    .select('*')
    .single();
  if (insErr) throw new Error(`conversation create failed: ${insErr.message}`);
  return { conversation: mapConversation(created), created: true };
}

export type AddMessageArgs = {
  clinicId: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  senderType: 'patient' | 'ai' | 'human' | 'system';
  senderUserId: string | null;
  contentType: Message['contentType'];
  content: string | null;
  externalId: string | null;
  deliveryStatus?: Message['deliveryStatus'];
  outboxStatus?: Message['outboxStatus'];
};

/**
 * Idempotent on (clinic_id, external_id) when externalId is set, enforced by
 * the partial UNIQUE index `idx_messages_clinic_external_id` (migration 0013).
 * Strategy is optimistic INSERT: try first, recover the existing row on
 * SQLSTATE 23505 (unique_violation). Closes the race window that the prior
 * SELECT-then-INSERT had under concurrent Kapso webhook retries.
 *
 * Trigger `update_conversation_on_message` fires AFTER each successful INSERT
 * and updates the parent conversation's denormalized fields automatically.
 */
export async function addMessage(
  sb: SupabaseClient,
  a: AddMessageArgs,
): Promise<{ message: Message; created: boolean }> {
  const insert: Record<string, unknown> = {
    clinic_id: a.clinicId,
    conversation_id: a.conversationId,
    direction: a.direction,
    sender_type: a.senderType,
    sender_user_id: a.senderUserId,
    content_type: a.contentType,
    content: a.content,
    external_id: a.externalId,
    delivery_status: a.deliveryStatus ?? 'pending',
  };
  if (a.outboxStatus !== undefined) insert['outbox_status'] = a.outboxStatus;

  const { data, error } = await sb.from('messages').insert(insert).select('*').single();
  if (!error) return { message: mapMessage(data), created: true };

  if (error.code === '23505' && a.externalId) {
    const { data: existing, error: lookErr } = await sb
      .from('messages')
      .select('*')
      .eq('clinic_id', a.clinicId)
      .eq('external_id', a.externalId)
      .maybeSingle();
    if (lookErr) throw new Error(`message lookup after conflict failed: ${lookErr.message}`);
    if (!existing) throw new Error('unique violation but row not found');
    return { message: mapMessage(existing), created: false };
  }

  throw new Error(`message insert failed: ${error.message}`);
}

// State ordering for terminal-state regression guard. A status webhook
// arriving out of order (e.g. a 'sent' confirmation after 'delivered' has
// already landed, or any callback after 'read'/'failed') is silently dropped
// instead of overwriting a more advanced state. failed=99 makes 'failed' an
// absolute terminal — once a row is failed, further updates are ignored.
const STATUS_ORDER: Record<NonNullable<Message['deliveryStatus']>, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 99,
};

/**
 * Update the delivery_status (and optional delivery_error) of an existing
 * outbound message, keyed by (clinic_id, external_id). On success returns
 * messageId + conversationId so a downstream realtime publisher can build
 * the channel name without re-querying. Returns `{ updated: false }` if no
 * row matches — common when a status webhook arrives before our INSERT
 * outbound path completes — or if the incoming status would regress a
 * more advanced state (terminal-state guard).
 */
export type UpdateDeliveryStatusResult =
  | { updated: false }
  | { updated: true; messageId: string; conversationId: string };

export async function updateMessageDeliveryStatus(
  sb: SupabaseClient,
  clinicId: string,
  evt: StatusUpdateEvent,
): Promise<UpdateDeliveryStatusResult> {
  const { data: current, error: selErr } = await sb
    .from('messages')
    .select('id, delivery_status, conversation_id')
    .eq('clinic_id', clinicId)
    .eq('external_id', evt.externalMessageId)
    .maybeSingle();
  if (selErr) throw new Error(`delivery_status lookup failed: ${selErr.message}`);
  if (!current) return { updated: false };

  const currentStatus = current.delivery_status as Message['deliveryStatus'];
  if (STATUS_ORDER[evt.status] <= STATUS_ORDER[currentStatus]) {
    return { updated: false };
  }

  const patch: Record<string, unknown> = { delivery_status: evt.status };
  if (evt.deliveryError) patch['delivery_error'] = evt.deliveryError;

  const { error: updErr } = await sb
    .from('messages')
    .update(patch)
    .eq('id', current.id as string);
  if (updErr) throw new Error(`delivery_status update failed: ${updErr.message}`);
  return {
    updated: true,
    messageId: current.id as string,
    conversationId: current.conversation_id as string,
  };
}

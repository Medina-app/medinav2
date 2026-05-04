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
  const insert = {
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

/**
 * Update the delivery_status (and optional delivery_error) of an existing
 * outbound message, keyed by (clinic_id, external_id). Returns updated=false
 * if no row matches — common when a status webhook arrives before our
 * INSERT outbound path completes.
 */
export async function updateMessageDeliveryStatus(
  sb: SupabaseClient,
  clinicId: string,
  evt: StatusUpdateEvent,
): Promise<{ updated: boolean }> {
  const patch: Record<string, unknown> = { delivery_status: evt.status };
  if (evt.deliveryError) patch['delivery_error'] = evt.deliveryError;

  const { data, error } = await sb
    .from('messages')
    .update(patch)
    .eq('clinic_id', clinicId)
    .eq('external_id', evt.externalMessageId)
    .select('id');
  if (error) throw new Error(`delivery_status update failed: ${error.message}`);
  return { updated: (data?.length ?? 0) > 0 };
}

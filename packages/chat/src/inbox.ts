import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConversationListItem, ConversationWithMessages } from './types.js';
import { mapConversation, mapMessage, mapPatient } from './mappers.js';

export type ListConversationsArgs = {
  includeResolved?: boolean;
  assignedUserId?: string;
};

/**
 * Returns conversations of a clinic for the inbox UI. Default ordering is
 * `last_message_at desc nulls last` so the freshest threads come first.
 *
 * RLS auto-filters when called with a server-bound client (UI flows). Webhook
 * flows pass an admin client and rely on the explicit `clinic_id` filter.
 */
export async function listConversations(
  sb: SupabaseClient,
  clinicId: string,
  args: ListConversationsArgs = {},
): Promise<ConversationListItem[]> {
  let query = sb
    .from('conversations')
    .select(
      'id, state, last_message_at, last_message_preview, unread_count, external_id, patient_id, patient:patients(full_name)',
    )
    .eq('clinic_id', clinicId)
    .is('deleted_at', null)
    .order('last_message_at', { ascending: false, nullsFirst: false });

  if (!args.includeResolved) query = query.neq('state', 'resolved');
  if (args.assignedUserId) query = query.eq('assigned_user_id', args.assignedUserId);

  const { data, error } = await query;
  if (error) throw new Error(`listConversations failed: ${error.message}`);

  return (data ?? []).map((row) => {
    const patientName =
      row.patient && typeof row.patient === 'object' && !Array.isArray(row.patient)
        ? ((row.patient as { full_name?: string | null }).full_name ?? null)
        : null;
    return {
      id: row.id as string,
      state: row.state as ConversationListItem['state'],
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at as string) : null,
      lastMessagePreview: row.last_message_preview as string | null,
      unreadCount: row.unread_count as number,
      externalId: row.external_id as string,
      patientId: row.patient_id as string | null,
      patientName,
    };
  });
}

/**
 * Returns the full conversation row + patient + messages ordered by
 * created_at ascending. Returns null if the conversation does not belong
 * to the given clinic (cross-tenant defense — RLS would also catch it
 * for UI flows, but admin clients need the explicit guard).
 */
export async function getConversationWithMessages(
  sb: SupabaseClient,
  clinicId: string,
  conversationId: string,
): Promise<ConversationWithMessages | null> {
  const { data: conv, error: cErr } = await sb
    .from('conversations')
    .select('*, patient:patients(id, full_name, phone, preferred_name)')
    .eq('id', conversationId)
    .eq('clinic_id', clinicId)
    .is('deleted_at', null)
    .maybeSingle();
  if (cErr) throw new Error(`getConversation failed: ${cErr.message}`);
  if (!conv) return null;

  const { data: msgs, error: mErr } = await sb
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (mErr) throw new Error(`getMessages failed: ${mErr.message}`);

  const patientRow = conv.patient as Record<string, unknown> | null;
  const patient = patientRow
    ? {
        id: patientRow['id'] as string,
        fullName: patientRow['full_name'] as string,
        phone: patientRow['phone'] as string,
        preferredName: patientRow['preferred_name'] as string | null,
      }
    : null;

  return {
    ...mapConversation(conv as Record<string, unknown>),
    patient,
    messages: (msgs ?? []).map((m) => mapMessage(m as Record<string, unknown>)),
  };
}

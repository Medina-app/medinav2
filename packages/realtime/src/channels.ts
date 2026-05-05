export type ParsedChannel =
  | { type: 'inbox'; clinicId: string }
  | { type: 'conversation'; conversationId: string };

export function buildInboxChannel(clinicId: string): string {
  return `inbox:${clinicId}`;
}

/**
 * Channel name for a single conversation. The `clinicId` arg is intentionally
 * unused — conversation_id is a globally unique UUID, so the channel name
 * doesn't need a redundant clinic prefix. Cross-tenant isolation is enforced
 * upstream by the JWT issuer (only the user's own clinic conversations land
 * in the token's channels claim, via assertTenantAccess + listConversations
 * which is RLS-scoped).
 *
 * Param kept in the signature so the 5 callers (workers, route, hook) don't
 * have to change. Drop in a follow-up cleanup if it ever becomes a nuisance.
 */
export function buildConversationChannel(_clinicId: string, conversationId: string): string {
  return `conv:${conversationId}`;
}

export function parseChannel(channel: string): ParsedChannel | null {
  const parts = channel.split(':');
  if (parts.length !== 2 || !parts[1]) return null;
  if (parts[0] === 'inbox') return { type: 'inbox', clinicId: parts[1] };
  if (parts[0] === 'conv') return { type: 'conversation', conversationId: parts[1] };
  return null;
}

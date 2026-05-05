export type ParsedChannel =
  | { type: 'inbox'; clinicId: string }
  | { type: 'conversation'; clinicId: string; conversationId: string };

export function buildInboxChannel(clinicId: string): string {
  return `clinic:${clinicId}:inbox`;
}

export function buildConversationChannel(clinicId: string, conversationId: string): string {
  return `clinic:${clinicId}:conv:${conversationId}`;
}

export function parseChannel(channel: string): ParsedChannel | null {
  const parts = channel.split(':');
  if (parts[0] !== 'clinic' || parts.length < 3) return null;
  const clinicId = parts[1];
  if (!clinicId) return null;
  if (parts[2] === 'inbox' && parts.length === 3) {
    return { type: 'inbox', clinicId };
  }
  if (parts[2] === 'conv' && parts.length === 4 && parts[3]) {
    return { type: 'conversation', clinicId, conversationId: parts[3] };
  }
  return null;
}

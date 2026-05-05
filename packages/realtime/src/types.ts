/**
 * Wire format for events published to Centrifugo channels. The client side
 * never trusts these payloads (router.refresh re-fetches the truth from the
 * server); they exist only to wake the UI up so the next refresh paints the
 * fresh state. Keeping ids in the payload lets future optimistic-update
 * extensions identify the affected row without parsing the channel.
 */
export type EventPayload =
  | { type: 'message.new'; conversationId: string; messageId: string }
  | { type: 'message.updated'; conversationId: string; messageId: string }
  | { type: 'conversation.updated'; conversationId: string };

export type EventType = EventPayload['type'];

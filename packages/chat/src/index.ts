export type {
  InboundMessageEvent,
  StatusUpdateEvent,
  ConversationListItem,
  ConversationWithMessages,
} from './types';

// Re-export the Drizzle row types so apps/web can build UI components without
// declaring a direct @medina/db dependency. CHAT-2 introduced retry_count and
// last_error_at — components rendering delivery status need the full shape.
export type { Message, Conversation, Patient } from '@medina/db';

export { lookupOrCreatePatientByPhone } from './patients';
export {
  getOrCreateConversation,
  addMessage,
  updateMessageDeliveryStatus,
  type GetOrCreateConversationArgs,
  type AddMessageArgs,
} from './conversations';
export {
  listConversations,
  getConversationWithMessages,
  type ListConversationsArgs,
} from './inbox';
export {
  queueOutboundMessage,
  type QueueOutboundMessageArgs,
  type InngestSendFn,
  type InngestOutboundEvent,
} from './outbox';

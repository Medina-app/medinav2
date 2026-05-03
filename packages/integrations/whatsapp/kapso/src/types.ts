import { z } from 'zod';

// Status entries inside `kapso.statuses[]` history array on outbound messages.
const KapsoStatusEntrySchema = z.object({
  id: z.string(),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: z.string(),
  recipient_id: z.string().optional(),
  errors: z
    .array(z.object({ code: z.number(), title: z.string(), message: z.string() }))
    .optional(),
});

// Kapso-injected metadata block alongside the Meta-shaped message object.
const KapsoMessageMetaSchema = z.object({
  direction: z.enum(['inbound', 'outbound']),
  status: z.enum(['received', 'sent', 'delivered', 'read', 'failed']),
  statuses: z.array(KapsoStatusEntrySchema).default([]),
});

// Single message envelope. `from` populated for inbound; `to` for outbound.
export const KapsoMessageSchema = z.object({
  id: z.string(),
  type: z.enum([
    'text',
    'image',
    'audio',
    'video',
    'document',
    'sticker',
    'location',
    'contacts',
    'interactive',
    'reaction',
  ]),
  timestamp: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  text: z.object({ body: z.string() }).optional(),
  kapso: KapsoMessageMetaSchema,
  errors: z
    .array(z.object({ code: z.number(), title: z.string(), message: z.string() }))
    .optional(),
});

// Conversation block — Kapso assigns its own ID + extra fields we don't model.
const KapsoConversationSchema = z
  .object({
    id: z.string(),
    phone_number: z.string().optional(),
  })
  .passthrough();

const KapsoMessageDataSchema = z.object({
  phone_number_id: z.string(),
  message: KapsoMessageSchema,
  conversation: KapsoConversationSchema.optional(),
});

export const KapsoWebhookPayloadSchema = z.object({
  type: z.string(),
  data: KapsoMessageDataSchema,
  test: z.boolean().optional(),
});

export type KapsoWebhookPayload = z.infer<typeof KapsoWebhookPayloadSchema>;
export type KapsoMessage = z.infer<typeof KapsoMessageSchema>;

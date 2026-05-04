import { z } from 'zod';

// Real Kapso webhook shape: event type travels in `X-Webhook-Event` header,
// body carries { message, conversation?, is_new_conversation?, phone_number_id }.
// All message events (received/sent/delivered/read/failed) share the same body
// shape; what differs is the header + `message.kapso.{direction,status}`.

const KapsoTextBody = z.object({ body: z.string() });

const KapsoErrorEntry = z.object({
  code: z.number(),
  title: z.string(),
  message: z.string(),
});

const KapsoStatusEntry = z.object({
  id: z.string(),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: z.string(),
  recipient_id: z.string().optional(),
  errors: z.array(KapsoErrorEntry).optional(),
});

const KapsoMessageMeta = z
  .object({
    direction: z.enum(['inbound', 'outbound']),
    status: z.enum(['received', 'sent', 'delivered', 'read', 'failed']),
    processing_status: z.string().optional(),
    origin: z.string().optional(),
    has_media: z.boolean().optional(),
    content: z.string().optional(),
    transcript: z.string().nullable().optional(),
    media_url: z.string().nullable().optional(),
    statuses: z.array(KapsoStatusEntry).optional(),
  })
  .passthrough();

export const KapsoMessageSchema = z
  .object({
    id: z.string(),
    type: z.string(), // text|image|audio|video|document|sticker|location|... (open-ended)
    timestamp: z.string(),
    from: z.string().optional(),
    to: z.string().optional(),
    from_user_id: z.string().optional(),
    username: z.string().nullable().optional(),
    text: KapsoTextBody.optional(),
    kapso: KapsoMessageMeta,
    errors: z.array(KapsoErrorEntry).optional(),
  })
  .passthrough();

const KapsoConversationSchema = z
  .object({
    id: z.string(),
    phone_number: z.string().optional(),
    contact_name: z.string().nullable().optional(),
  })
  .passthrough();

export const KapsoMessageEventPayloadSchema = z
  .object({
    message: KapsoMessageSchema,
    conversation: KapsoConversationSchema.optional(),
    is_new_conversation: z.boolean().optional(),
    phone_number_id: z.string(),
  })
  .passthrough();

export type KapsoMessageEventPayload = z.infer<typeof KapsoMessageEventPayloadSchema>;
export type KapsoMessage = z.infer<typeof KapsoMessageSchema>;

import { describe, it, expect } from 'vitest';
import { KapsoWebhookPayloadSchema } from '../src/types.js';

const inboundTextSample = {
  type: 'whatsapp.message.received',
  data: {
    phone_number_id: '647015955153740',
    message: {
      id: 'wamid.HBgLNTU=',
      from: '+5511987654321',
      type: 'text',
      timestamp: '1714752000',
      text: { body: 'Oi, gostaria de marcar consulta' },
      kapso: {
        direction: 'inbound',
        status: 'received',
        statuses: [],
      },
    },
    conversation: { id: 'conv-abc', phone_number: '+5511987654321' },
  },
};

describe('KapsoWebhookPayloadSchema', () => {
  it('validates an inbound text message payload', () => {
    const parsed = KapsoWebhookPayloadSchema.safeParse(inboundTextSample);
    expect(parsed.success).toBe(true);
  });

  it('rejects a payload missing the type field', () => {
    const parsed = KapsoWebhookPayloadSchema.safeParse({ data: inboundTextSample.data });
    expect(parsed.success).toBe(false);
  });
});

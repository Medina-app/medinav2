import { describe, it, expect } from 'vitest';
import { KapsoWebhookPayloadSchema } from '../src/types.js';
import { parseInboundMessage, parseStatusUpdate, extractPhoneNumberId } from '../src/parse.js';

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

describe('parseInboundMessage', () => {
  it('returns canonical InboundMessageEvent for inbound text', () => {
    const event = parseInboundMessage(inboundTextSample);
    expect(event).toEqual({
      kind: 'inbound_message',
      externalMessageId: 'wamid.HBgLNTU=',
      fromPhone: '+5511987654321',
      contentType: 'text',
      content: 'Oi, gostaria de marcar consulta',
      receivedAt: new Date(1714752000 * 1000),
      phoneNumberId: '647015955153740',
      kapsoConversationId: 'conv-abc',
    });
  });

  it('returns null when type is not whatsapp.message.received', () => {
    const otherEvent = { ...inboundTextSample, type: 'whatsapp.message.delivered' };
    expect(parseInboundMessage(otherEvent)).toBeNull();
  });

  it('uses placeholder content for non-text types (image)', () => {
    const imageSample = {
      ...inboundTextSample,
      data: {
        ...inboundTextSample.data,
        message: {
          ...inboundTextSample.data.message,
          type: 'image',
          text: undefined,
        },
      },
    };
    const event = parseInboundMessage(imageSample);
    expect(event).not.toBeNull();
    expect(event!.contentType).toBe('image');
    expect(event!.content).toBe('[Anexo não exibido — suporte em CHAT-4]');
  });

  it('falls back to system content_type for sticker (not in DB enum)', () => {
    const stickerSample = {
      ...inboundTextSample,
      data: {
        ...inboundTextSample.data,
        message: {
          ...inboundTextSample.data.message,
          type: 'sticker',
          text: undefined,
        },
      },
    };
    const event = parseInboundMessage(stickerSample);
    expect(event!.contentType).toBe('system');
  });

  it('returns null when message has no `from` field', () => {
    const broken = {
      ...inboundTextSample,
      data: {
        ...inboundTextSample.data,
        message: { ...inboundTextSample.data.message, from: undefined },
      },
    };
    expect(parseInboundMessage(broken)).toBeNull();
  });
});

describe('parseStatusUpdate', () => {
  const baseStatus = {
    type: 'whatsapp.message.delivered',
    data: {
      phone_number_id: '647015955153740',
      message: {
        id: 'wamid.OUT-1',
        type: 'text',
        timestamp: '1714752100',
        to: '+5511987654321',
        kapso: { direction: 'outbound', status: 'delivered', statuses: [] },
      },
    },
  };

  it('maps whatsapp.message.delivered to delivered status', () => {
    expect(parseStatusUpdate(baseStatus)).toEqual({
      kind: 'status_update',
      externalMessageId: 'wamid.OUT-1',
      status: 'delivered',
      deliveryError: undefined,
    });
  });

  it('maps whatsapp.message.read to read status', () => {
    const sample = { ...baseStatus, type: 'whatsapp.message.read' };
    expect(parseStatusUpdate(sample)?.status).toBe('read');
  });

  it('extracts errors[0].message as deliveryError on failed', () => {
    const failed = {
      type: 'whatsapp.message.failed',
      data: {
        phone_number_id: 'X',
        message: {
          id: 'wamid.FAIL',
          type: 'text',
          timestamp: '1',
          to: '+5511',
          kapso: { direction: 'outbound', status: 'failed', statuses: [] },
          errors: [{ code: 131047, title: 'Re-engagement', message: 'Re-engagement message' }],
        },
      },
    };
    const event = parseStatusUpdate(failed);
    expect(event?.status).toBe('failed');
    expect(event?.deliveryError).toBe('Re-engagement message');
  });

  it('returns null for non-status events', () => {
    expect(parseStatusUpdate(inboundTextSample)).toBeNull();
  });
});

describe('extractPhoneNumberId', () => {
  it('reads top-level data.phone_number_id', () => {
    expect(extractPhoneNumberId(inboundTextSample)).toBe('647015955153740');
  });

  it('returns null for invalid payloads', () => {
    expect(extractPhoneNumberId({ random: 'junk' })).toBeNull();
  });
});

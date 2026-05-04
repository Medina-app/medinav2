import { describe, it, expect } from 'vitest';
import { KapsoMessageEventPayloadSchema } from '../src/types';
import {
  parseInboundMessage,
  parseStatusUpdate,
  extractPhoneNumberId,
} from '../src/parse';

// Real Kapso payload shape captured from production smoke test.
const inboundTextSample = {
  message: {
    from: '5581987654321',
    id: 'wamid.HBgMNTU4MTk4NzY1NDMyMQ==',
    kapso: {
      direction: 'inbound',
      status: 'received',
      processing_status: 'pending',
      has_media: false,
      origin: 'cloud_api',
      content: 'Quero consulta',
    },
    text: { body: 'Quero consulta' },
    timestamp: '1777856191',
    type: 'text',
    username: null,
    from_user_id: 'BR.1234567890',
    context: null,
  },
  conversation: {
    id: '621d84ec-21a7-4377-ac3c-f0de5d69f057',
    business_scoped_user_id: 'BR.1234567890',
    contact_name: 'Gabriel Arruda',
  },
  is_new_conversation: true,
  phone_number_id: '647015955153740',
};

const inboundImageSample = {
  ...inboundTextSample,
  message: {
    ...inboundTextSample.message,
    type: 'image',
    text: undefined,
    kapso: { ...inboundTextSample.message.kapso, has_media: true, content: '' },
  },
};

const deliveredStatusSample = {
  message: {
    id: 'wamid.OUTBOUND-1',
    type: 'text',
    timestamp: '1777856200',
    to: '5581987654321',
    text: { body: 'Resposta da clínica' },
    kapso: {
      direction: 'outbound',
      status: 'delivered',
      processing_status: 'completed',
      origin: 'cloud_api',
      has_media: false,
      statuses: [
        { id: 'wamid.OUTBOUND-1', status: 'sent', timestamp: '1777856195' },
        { id: 'wamid.OUTBOUND-1', status: 'delivered', timestamp: '1777856200' },
      ],
    },
  },
  conversation: { id: 'conv-x' },
  phone_number_id: '647015955153740',
};

const failedStatusSample = {
  message: {
    id: 'wamid.OUTBOUND-FAIL',
    type: 'text',
    timestamp: '1777856200',
    to: '5581987654321',
    kapso: {
      direction: 'outbound',
      status: 'failed',
      processing_status: 'completed',
      origin: 'cloud_api',
      has_media: false,
      statuses: [],
    },
    errors: [
      { code: 131047, title: 'Re-engagement message', message: 'More than 24 hours have passed since recipient last replied' },
    ],
  },
  phone_number_id: '647015955153740',
};

describe('KapsoMessageEventPayloadSchema', () => {
  it('validates the real inbound text payload shape', () => {
    expect(KapsoMessageEventPayloadSchema.safeParse(inboundTextSample).success).toBe(true);
  });

  it('rejects a payload missing the message field', () => {
    expect(KapsoMessageEventPayloadSchema.safeParse({ conversation: {}, phone_number_id: 'X' }).success).toBe(false);
  });

  it('rejects a payload missing phone_number_id', () => {
    const { phone_number_id: _ignored, ...rest } = inboundTextSample;
    void _ignored;
    expect(KapsoMessageEventPayloadSchema.safeParse(rest).success).toBe(false);
  });
});

describe('parseInboundMessage', () => {
  it('returns null when event header is not whatsapp.message.received', () => {
    expect(parseInboundMessage('whatsapp.message.delivered', inboundTextSample)).toBeNull();
    expect(parseInboundMessage(undefined, inboundTextSample)).toBeNull();
  });

  // Scenario 1: parses inbound text message with real Kapso shape
  it('returns canonical InboundMessageEvent for inbound text', () => {
    const event = parseInboundMessage('whatsapp.message.received', inboundTextSample);
    expect(event).toEqual({
      kind: 'inbound_message',
      externalMessageId: 'wamid.HBgMNTU4MTk4NzY1NDMyMQ==',
      fromPhone: '+5581987654321', // normalized to E.164
      contentType: 'text',
      content: 'Quero consulta',
      receivedAt: new Date(1777856191 * 1000),
      phoneNumberId: '647015955153740',
      kapsoConversationId: '621d84ec-21a7-4377-ac3c-f0de5d69f057',
      patientNameHint: 'Gabriel Arruda',
    });
  });

  it('passes through phones already in E.164 format', () => {
    const sample = {
      ...inboundTextSample,
      message: { ...inboundTextSample.message, from: '+5581987654321' },
    };
    expect(parseInboundMessage('whatsapp.message.received', sample)?.fromPhone).toBe('+5581987654321');
  });

  // Scenario 2 (parse half): unsupported types map to placeholder content
  it('maps non-text types to placeholder content but keeps the type', () => {
    const event = parseInboundMessage('whatsapp.message.received', inboundImageSample);
    expect(event).not.toBeNull();
    expect(event!.contentType).toBe('image');
    expect(event!.content).toBe('[Anexo não exibido — suporte em CHAT-4]');
  });

  it('falls back to system content_type for sticker (not in DB enum)', () => {
    const sample = {
      ...inboundTextSample,
      message: { ...inboundTextSample.message, type: 'sticker', text: undefined },
    };
    expect(parseInboundMessage('whatsapp.message.received', sample)?.contentType).toBe('system');
  });

  it('returns null when message has no `from` field', () => {
    const sample = {
      ...inboundTextSample,
      message: { ...inboundTextSample.message, from: undefined },
    };
    expect(parseInboundMessage('whatsapp.message.received', sample)).toBeNull();
  });

  it('returns patientNameHint=null when conversation has no contact_name', () => {
    const sample = {
      ...inboundTextSample,
      conversation: { ...inboundTextSample.conversation, contact_name: null },
    };
    expect(parseInboundMessage('whatsapp.message.received', sample)?.patientNameHint).toBeNull();
  });
});

describe('parseStatusUpdate', () => {
  it('maps whatsapp.message.delivered header to delivered status', () => {
    expect(parseStatusUpdate('whatsapp.message.delivered', deliveredStatusSample)).toEqual({
      kind: 'status_update',
      externalMessageId: 'wamid.OUTBOUND-1',
      status: 'delivered',
      deliveryError: undefined,
    });
  });

  it('maps whatsapp.message.read header to read status', () => {
    expect(parseStatusUpdate('whatsapp.message.read', deliveredStatusSample)?.status).toBe('read');
  });

  it('maps whatsapp.message.sent header to sent status', () => {
    expect(parseStatusUpdate('whatsapp.message.sent', deliveredStatusSample)?.status).toBe('sent');
  });

  it('extracts errors[0].message as deliveryError on failed', () => {
    const event = parseStatusUpdate('whatsapp.message.failed', failedStatusSample);
    expect(event?.status).toBe('failed');
    expect(event?.deliveryError).toBe('More than 24 hours have passed since recipient last replied');
  });

  it('returns null for non-status events', () => {
    expect(parseStatusUpdate('whatsapp.message.received', inboundTextSample)).toBeNull();
    expect(parseStatusUpdate('whatsapp.conversation.created', {})).toBeNull();
    expect(parseStatusUpdate(undefined, deliveredStatusSample)).toBeNull();
  });
});

describe('extractPhoneNumberId', () => {
  it('reads top-level phone_number_id', () => {
    expect(extractPhoneNumberId(inboundTextSample)).toBe('647015955153740');
  });

  it('returns null for invalid payloads', () => {
    expect(extractPhoneNumberId({ random: 'junk' })).toBeNull();
  });
});

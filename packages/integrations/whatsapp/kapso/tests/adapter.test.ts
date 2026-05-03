import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @medina/chat helpers BEFORE importing the adapter so it picks up the mocks
vi.mock('@medina/chat', () => ({
  lookupOrCreatePatientByPhone: vi.fn(),
  getOrCreateConversation: vi.fn(),
  addMessage: vi.fn(),
  updateMessageDeliveryStatus: vi.fn(),
}));

// Build a mock Supabase client with chainable .from(x).update(y).eq(z) returning a thenable
function buildMockSupabase() {
  const updateEq = vi.fn().mockResolvedValue({ data: null, error: null });
  const updateChain = { eq: updateEq };
  const fromChain = { update: vi.fn().mockReturnValue(updateChain) };
  const from = vi.fn().mockReturnValue(fromChain);
  return { client: { from } as unknown, fromMock: from, updateMock: fromChain.update, eqMock: updateEq };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}));

import { createClient } from '@supabase/supabase-js';
import {
  lookupOrCreatePatientByPhone,
  getOrCreateConversation,
  addMessage,
  updateMessageDeliveryStatus,
} from '@medina/chat';
import { kapsoAdapter } from '../src/adapter.js';

const baseInbound = {
  type: 'whatsapp.message.received',
  data: {
    phone_number_id: '647015955153740',
    message: {
      id: 'wamid.IN-1',
      from: '+5511987654321',
      type: 'text',
      timestamp: '1714752000',
      text: { body: 'oi' },
      kapso: { direction: 'inbound', status: 'received', statuses: [] },
    },
    conversation: { id: 'conv-1' },
  },
};

function buildCtx(payload: unknown, integration: Record<string, unknown> = {}) {
  return {
    clinicId: 'clinic-1',
    integration: {
      id: 'integ-1',
      clinicId: 'clinic-1',
      type: 'whatsapp',
      provider: 'kapso',
      name: 'WA',
      status: 'active',
      config: {},
      ...integration,
    },
    payload,
    headers: {},
    rawBody: JSON.stringify(payload),
  } as Parameters<typeof kapsoAdapter.handle>[0];
}

beforeEach(() => {
  const { client } = buildMockSupabase();
  vi.mocked(createClient).mockReturnValue(client as ReturnType<typeof createClient>);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('kapsoAdapter contract', () => {
  it('signatureHeader is x-webhook-signature', () => {
    expect(kapsoAdapter.signatureHeader).toBe('x-webhook-signature');
  });
  it('type is whatsapp and provider is kapso', () => {
    expect(kapsoAdapter.type).toBe('whatsapp');
    expect(kapsoAdapter.provider).toBe('kapso');
  });
});

describe('kapsoAdapter.handle inbound message', () => {
  it('inbound text → patient + conversation + message inserted', async () => {
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({
      patient: { id: 'pat-1' } as never,
      created: false,
    });
    vi.mocked(getOrCreateConversation).mockResolvedValue({
      conversation: { id: 'conv-uuid' } as never,
      created: false,
    });
    vi.mocked(addMessage).mockResolvedValue({
      message: { id: 'msg-1' } as never,
      created: true,
    });

    const result = await kapsoAdapter.handle(buildCtx(baseInbound));

    expect(result.processed).toBe(true);
    expect(result.reason).toBe('message_inserted');
    expect(lookupOrCreatePatientByPhone).toHaveBeenCalledWith(
      expect.anything(),
      'clinic-1',
      '+5511987654321',
    );
    expect(getOrCreateConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clinicId: 'clinic-1',
        integrationId: 'integ-1',
        channel: 'whatsapp',
        externalId: '+5511987654321',
        patientId: 'pat-1',
      }),
    );
    expect(addMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clinicId: 'clinic-1',
        conversationId: 'conv-uuid',
        direction: 'inbound',
        senderType: 'patient',
        contentType: 'text',
        content: 'oi',
        externalId: 'wamid.IN-1',
        deliveryStatus: 'delivered',
      }),
    );
  });

  it('returns reason=duplicate_idempotent when addMessage reports created=false', async () => {
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({ patient: { id: 'pat' } as never, created: false });
    vi.mocked(getOrCreateConversation).mockResolvedValue({ conversation: { id: 'conv' } as never, created: false });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: false });

    const result = await kapsoAdapter.handle(buildCtx(baseInbound));
    expect(result.reason).toBe('duplicate_idempotent');
  });

  it('non-text type maps to placeholder content', async () => {
    const imagePayload = {
      ...baseInbound,
      data: {
        ...baseInbound.data,
        message: { ...baseInbound.data.message, type: 'image', text: undefined },
      },
    };
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({ patient: { id: 'pat' } as never, created: false });
    vi.mocked(getOrCreateConversation).mockResolvedValue({ conversation: { id: 'conv' } as never, created: false });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: true });

    await kapsoAdapter.handle(buildCtx(imagePayload));

    expect(addMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contentType: 'image',
        content: '[Anexo não exibido — suporte em CHAT-4]',
      }),
    );
  });

  it('captures phone_number_id into integration.config when missing', async () => {
    const captured = buildMockSupabase();
    vi.mocked(createClient).mockReturnValue(captured.client as ReturnType<typeof createClient>);
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({ patient: { id: 'pat' } as never, created: false });
    vi.mocked(getOrCreateConversation).mockResolvedValue({ conversation: { id: 'conv' } as never, created: false });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: true });

    await kapsoAdapter.handle(buildCtx(baseInbound));

    expect(captured.fromMock).toHaveBeenCalledWith('clinic_integrations');
    expect(captured.updateMock).toHaveBeenCalledWith({
      config: { phone_number_id: '647015955153740' },
    });
    expect(captured.eqMock).toHaveBeenCalledWith('id', 'integ-1');
  });

  it('does NOT update integration.config when phone_number_id already matches', async () => {
    const captured = buildMockSupabase();
    vi.mocked(createClient).mockReturnValue(captured.client as ReturnType<typeof createClient>);
    vi.mocked(lookupOrCreatePatientByPhone).mockResolvedValue({ patient: { id: 'pat' } as never, created: false });
    vi.mocked(getOrCreateConversation).mockResolvedValue({ conversation: { id: 'conv' } as never, created: false });
    vi.mocked(addMessage).mockResolvedValue({ message: { id: 'msg' } as never, created: true });

    await kapsoAdapter.handle(
      buildCtx(baseInbound, { config: { phone_number_id: '647015955153740' } }),
    );

    expect(captured.fromMock).not.toHaveBeenCalledWith('clinic_integrations');
  });
});

describe('kapsoAdapter.handle status update', () => {
  const deliveredPayload = {
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

  it('delivered → updateMessageDeliveryStatus called, processed=true', async () => {
    vi.mocked(updateMessageDeliveryStatus).mockResolvedValue({ updated: true });

    const result = await kapsoAdapter.handle(buildCtx(deliveredPayload));

    expect(result.processed).toBe(true);
    expect(result.reason).toBe('status_updated');
    expect(updateMessageDeliveryStatus).toHaveBeenCalledWith(
      expect.anything(),
      'clinic-1',
      expect.objectContaining({ kind: 'status_update', externalMessageId: 'wamid.OUT-1', status: 'delivered' }),
    );
  });

  it('returns processed=false reason=message_not_found when nothing updated', async () => {
    vi.mocked(updateMessageDeliveryStatus).mockResolvedValue({ updated: false });

    const result = await kapsoAdapter.handle(buildCtx(deliveredPayload));
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('message_not_found');
  });
});

describe('kapsoAdapter.handle unhandled events', () => {
  it('returns processed=false reason=unhandled_event for whatsapp.conversation.created', async () => {
    const result = await kapsoAdapter.handle(
      buildCtx({ type: 'whatsapp.conversation.created', data: {} }),
    );
    expect(result.processed).toBe(false);
    expect(result.reason).toBe('unhandled_event');
  });
});

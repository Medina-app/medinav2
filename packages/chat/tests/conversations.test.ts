import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getOrCreateConversation,
  addMessage,
  updateMessageDeliveryStatus,
} from '../src/conversations.js';
import {
  createTestClinic,
  createTestIntegration,
  createTestPatient,
  deleteTestClinic,
  getAdminSupabase,
} from './helpers.js';

const sb = getAdminSupabase();
const createdClinics: string[] = [];

afterAll(async () => {
  for (const id of createdClinics) await deleteTestClinic(sb, id);
});

async function makeContext(name: string) {
  const clinic = await createTestClinic(sb, name);
  createdClinics.push(clinic.id);
  const integration = await createTestIntegration(sb, clinic.id);
  return { clinic, integration };
}

describe('getOrCreateConversation', () => {
  it('creates conversation on first call', async () => {
    const { clinic, integration } = await makeContext('ConvCreate');
    const phone = `+5511${Date.now().toString().slice(-9)}`;

    const result = await getOrCreateConversation(sb, {
      clinicId: clinic.id,
      integrationId: integration.id,
      channel: 'whatsapp',
      externalId: phone,
      patientId: null,
    });

    expect(result.created).toBe(true);
    expect(result.conversation.externalId).toBe(phone);
    expect(result.conversation.state).toBe('waiting_human');
  });

  it('is idempotent: second call returns same id, created=false', async () => {
    const { clinic, integration } = await makeContext('ConvIdempotent');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const args = {
      clinicId: clinic.id,
      integrationId: integration.id,
      channel: 'whatsapp' as const,
      externalId: phone,
      patientId: null,
    };

    const first = await getOrCreateConversation(sb, args);
    const second = await getOrCreateConversation(sb, args);

    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe(first.conversation.id);
  });
});

describe('addMessage', () => {
  it('inserts inbound message; trigger updates last_message_at + unread_count', async () => {
    const { clinic, integration } = await makeContext('AddInbound');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const { conversation } = await getOrCreateConversation(sb, {
      clinicId: clinic.id, integrationId: integration.id,
      channel: 'whatsapp', externalId: phone, patientId: null,
    });

    const result = await addMessage(sb, {
      clinicId: clinic.id,
      conversationId: conversation.id,
      direction: 'inbound',
      senderType: 'patient',
      senderUserId: null,
      contentType: 'text',
      content: 'oi',
      externalId: 'wamid.IN-1',
      deliveryStatus: 'delivered',
    });

    expect(result.created).toBe(true);
    expect(result.message.direction).toBe('inbound');

    const { data: convAfter } = await sb.from('conversations')
      .select('last_message_at, last_message_preview, unread_count')
      .eq('id', conversation.id).single();
    expect(convAfter?.last_message_at).not.toBeNull();
    expect(convAfter?.last_message_preview).toBe('oi');
    expect(convAfter?.unread_count).toBe(1);
  });

  it('with same external_id returns existing message (idempotent retry)', async () => {
    const { clinic, integration } = await makeContext('AddIdempotent');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const { conversation } = await getOrCreateConversation(sb, {
      clinicId: clinic.id, integrationId: integration.id,
      channel: 'whatsapp', externalId: phone, patientId: null,
    });

    const args = {
      clinicId: clinic.id,
      conversationId: conversation.id,
      direction: 'inbound' as const,
      senderType: 'patient' as const,
      senderUserId: null,
      contentType: 'text' as const,
      content: 'duplicate me',
      externalId: 'wamid.SAME',
      deliveryStatus: 'delivered' as const,
    };

    const first = await addMessage(sb, args);
    const second = await addMessage(sb, args);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);
  });

  it('outbound message resets unread_count to 0', async () => {
    const { clinic, integration } = await makeContext('AddOutbound');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const { conversation } = await getOrCreateConversation(sb, {
      clinicId: clinic.id, integrationId: integration.id,
      channel: 'whatsapp', externalId: phone, patientId: null,
    });

    await addMessage(sb, {
      clinicId: clinic.id, conversationId: conversation.id,
      direction: 'inbound', senderType: 'patient', senderUserId: null,
      contentType: 'text', content: 'inbound', externalId: 'wamid.IN-OUT-1',
      deliveryStatus: 'delivered',
    });
    await addMessage(sb, {
      clinicId: clinic.id, conversationId: conversation.id,
      direction: 'outbound', senderType: 'human', senderUserId: null,
      contentType: 'text', content: 'reply', externalId: 'wamid.OUT-OUT-1',
      deliveryStatus: 'sent',
    });

    const { data } = await sb.from('conversations').select('unread_count').eq('id', conversation.id).single();
    expect(data?.unread_count).toBe(0);
  });
});

describe('updateMessageDeliveryStatus', () => {
  it('updates row by (clinic_id, external_id)', async () => {
    const { clinic, integration } = await makeContext('UpdStatus');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const { conversation } = await getOrCreateConversation(sb, {
      clinicId: clinic.id, integrationId: integration.id,
      channel: 'whatsapp', externalId: phone, patientId: null,
    });
    await addMessage(sb, {
      clinicId: clinic.id, conversationId: conversation.id,
      direction: 'outbound', senderType: 'human', senderUserId: null,
      contentType: 'text', content: 'reply', externalId: 'wamid.STATUS-1',
      deliveryStatus: 'sent',
    });

    const result = await updateMessageDeliveryStatus(sb, clinic.id, {
      kind: 'status_update',
      externalMessageId: 'wamid.STATUS-1',
      status: 'delivered',
      deliveryError: undefined,
    });

    expect(result.updated).toBe(true);
    const { data } = await sb.from('messages')
      .select('delivery_status').eq('external_id', 'wamid.STATUS-1').single();
    expect(data?.delivery_status).toBe('delivered');
  });

  it('returns updated=false when no row matches', async () => {
    const { clinic } = await makeContext('UpdMissing');

    const result = await updateMessageDeliveryStatus(sb, clinic.id, {
      kind: 'status_update',
      externalMessageId: 'wamid.NEVER-EXISTED',
      status: 'delivered',
      deliveryError: undefined,
    });

    expect(result.updated).toBe(false);
  });
});

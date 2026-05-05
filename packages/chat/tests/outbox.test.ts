import { afterAll, describe, expect, it, vi } from 'vitest';
import { queueOutboundMessage } from '../src/outbox';
import { getOrCreateConversation } from '../src/conversations';
import {
  createTestClinic,
  createTestIntegration,
  deleteTestClinic,
  getAdminSupabase,
} from './helpers';

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

describe('queueOutboundMessage', () => {
  it('creates a message with outbox_status=pending and delivery_status=pending', async () => {
    const { clinic, integration } = await makeContext('QueueCreate');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const { conversation } = await getOrCreateConversation(sb, {
      clinicId: clinic.id, integrationId: integration.id,
      channel: 'whatsapp', externalId: phone, patientId: null,
    });

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const result = await queueOutboundMessage(sb, inngestSend, {
      clinicId: clinic.id,
      conversationId: conversation.id,
      content: 'olá paciente',
      senderUserId: null,
    });

    expect(result.messageId).toBeDefined();
    const { data } = await sb.from('messages')
      .select('outbox_status, delivery_status, content, direction, sender_type, retry_count')
      .eq('id', result.messageId).single();
    expect(data?.outbox_status).toBe('pending');
    expect(data?.delivery_status).toBe('pending');
    expect(data?.content).toBe('olá paciente');
    expect(data?.direction).toBe('outbound');
    expect(data?.sender_type).toBe('human');
    expect(data?.retry_count).toBe(0);
  });

  it('dispatches inngest event with deterministic id outbound:${messageId}', async () => {
    const { clinic, integration } = await makeContext('QueueDispatch');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const { conversation } = await getOrCreateConversation(sb, {
      clinicId: clinic.id, integrationId: integration.id,
      channel: 'whatsapp', externalId: phone, patientId: null,
    });

    const inngestSend = vi.fn().mockResolvedValue(undefined);
    const result = await queueOutboundMessage(sb, inngestSend, {
      clinicId: clinic.id,
      conversationId: conversation.id,
      content: 'oi',
      senderUserId: null,
    });

    expect(inngestSend).toHaveBeenCalledTimes(1);
    expect(inngestSend).toHaveBeenCalledWith({
      name: 'chat/message.outbound',
      id: `outbound:${result.messageId}`,
      data: {
        messageId: result.messageId,
        clinicId: clinic.id,
        conversationId: conversation.id,
      },
    });
  });

  it('does not call Kapso API — only INSERT + dispatch', async () => {
    // Supabase JS uses fetch internally for the INSERT, so we can't assert
    // "no fetch at all". Instead we check no fetch hits api.kapso.ai —
    // the queue helper must not synchronously talk to the WhatsApp provider.
    const { clinic, integration } = await makeContext('QueueNoKapso');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const { conversation } = await getOrCreateConversation(sb, {
      clinicId: clinic.id, integrationId: integration.id,
      channel: 'whatsapp', externalId: phone, patientId: null,
    });

    const fetchSpy = vi.spyOn(global, 'fetch');
    const inngestSend = vi.fn().mockResolvedValue(undefined);
    await queueOutboundMessage(sb, inngestSend, {
      clinicId: clinic.id,
      conversationId: conversation.id,
      content: 'no kapso',
      senderUserId: null,
    });

    const kapsoCalls = fetchSpy.mock.calls.filter((call) => {
      const url = typeof call[0] === 'string' ? call[0] : call[0]?.toString() ?? '';
      return url.includes('kapso.ai');
    });
    expect(kapsoCalls).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  it('returns immediately even if inngestSend rejects (does not orphan the row)', async () => {
    // Note: the spec is "queue first, dispatch second; if dispatch fails, the
    // INSERT was already committed, and the worker can be restarted later via
    // a cron sweep on outbox_status=pending older than X minutes." So the
    // helper RE-throws the dispatch error; the row remains queued for sweep.
    const { clinic, integration } = await makeContext('QueueDispatchFail');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const { conversation } = await getOrCreateConversation(sb, {
      clinicId: clinic.id, integrationId: integration.id,
      channel: 'whatsapp', externalId: phone, patientId: null,
    });

    const inngestSend = vi.fn().mockRejectedValue(new Error('inngest down'));
    await expect(
      queueOutboundMessage(sb, inngestSend, {
        clinicId: clinic.id,
        conversationId: conversation.id,
        content: 'will fail dispatch',
        senderUserId: null,
      }),
    ).rejects.toThrow(/inngest down/);

    // Verify row was still inserted (the worker sweep can pick it up later)
    const { data } = await sb.from('messages')
      .select('outbox_status, content')
      .eq('clinic_id', clinic.id)
      .eq('content', 'will fail dispatch')
      .single();
    expect(data?.outbox_status).toBe('pending');
  });
});

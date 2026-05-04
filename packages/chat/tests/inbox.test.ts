import { afterAll, describe, expect, it } from 'vitest';
import { listConversations, getConversationWithMessages } from '../src/inbox';
import { addMessage, getOrCreateConversation } from '../src/conversations';
import { lookupOrCreatePatientByPhone } from '../src/patients';
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

async function seedConversation(
  clinicId: string,
  integrationId: string,
  phone: string,
  withPatient = true,
) {
  const patientId = withPatient
    ? (await lookupOrCreatePatientByPhone(sb, clinicId, phone)).patient.id
    : null;
  const { conversation } = await getOrCreateConversation(sb, {
    clinicId,
    integrationId,
    channel: 'whatsapp',
    externalId: phone,
    patientId,
  });
  return conversation;
}

describe('listConversations', () => {
  it('returns conversations of the clinic ordered by last_message_at desc nulls last', async () => {
    const { clinic, integration } = await makeContext('ListOrder');
    const phone1 = `+5511${Date.now().toString().slice(-9)}`;
    const phone2 = `+5512${Date.now().toString().slice(-9)}`;
    const c1 = await seedConversation(clinic.id, integration.id, phone1);
    const c2 = await seedConversation(clinic.id, integration.id, phone2);
    // c1 receives an inbound message → last_message_at populated
    await addMessage(sb, {
      clinicId: clinic.id, conversationId: c1.id,
      direction: 'inbound', senderType: 'patient', senderUserId: null,
      contentType: 'text', content: 'first', externalId: 'wamid.LIST-1',
      deliveryStatus: 'delivered',
    });
    // small delay to ensure ordering
    await new Promise((r) => setTimeout(r, 10));
    await addMessage(sb, {
      clinicId: clinic.id, conversationId: c2.id,
      direction: 'inbound', senderType: 'patient', senderUserId: null,
      contentType: 'text', content: 'second', externalId: 'wamid.LIST-2',
      deliveryStatus: 'delivered',
    });

    const result = await listConversations(sb, clinic.id);

    const ids = result.map((c) => c.id);
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c2.id);
    expect(ids[0]).toBe(c2.id); // most recent first
  });

  it('excludes state=resolved by default; includeResolved=true reverses', async () => {
    const { clinic, integration } = await makeContext('ListResolved');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const conv = await seedConversation(clinic.id, integration.id, phone);
    await sb.from('conversations').update({ state: 'resolved', resolved_at: new Date().toISOString() }).eq('id', conv.id);

    const defaultList = await listConversations(sb, clinic.id);
    expect(defaultList.find((c) => c.id === conv.id)).toBeUndefined();

    const fullList = await listConversations(sb, clinic.id, { includeResolved: true });
    expect(fullList.find((c) => c.id === conv.id)).toBeDefined();
  });

  it('filters by assignedUserId when provided', async () => {
    const { clinic, integration } = await makeContext('ListAssigned');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const conv = await seedConversation(clinic.id, integration.id, phone);

    const { data: userData, error: userErr } = await sb.auth.admin.createUser({
      email: `test-${crypto.randomUUID()}@medina-test.internal`,
      email_confirm: true,
    });
    if (userErr || !userData.user) throw new Error(`createUser failed: ${userErr?.message}`);
    const userId = userData.user.id;

    const { error: updErr } = await sb.from('conversations')
      .update({ assigned_user_id: userId }).eq('id', conv.id);
    if (updErr) throw new Error(`assigned_user_id update failed: ${updErr.message}`);

    const filtered = await listConversations(sb, clinic.id, { assignedUserId: userId });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.id).toBe(conv.id);

    // Cleanup the auth user we created (won't cascade to clinic; clinic deleteTestClinic handles its rows)
    await sb.auth.admin.deleteUser(userId);
  });

  it('cross-tenant: clinic A does not see clinic B conversations', async () => {
    const a = await makeContext('ListIsoA');
    const b = await makeContext('ListIsoB');
    const phoneB = `+5511${Date.now().toString().slice(-9)}`;
    await seedConversation(b.clinic.id, b.integration.id, phoneB);

    const result = await listConversations(sb, a.clinic.id);
    expect(result.find((c) => c.externalId === phoneB)).toBeUndefined();
  });

  it('joins patient name when patient_id is set', async () => {
    const { clinic, integration } = await makeContext('ListPatientName');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const { patient } = await lookupOrCreatePatientByPhone(sb, clinic.id, phone);
    await sb.from('patients').update({ full_name: 'Maria Silva' }).eq('id', patient.id);
    await getOrCreateConversation(sb, {
      clinicId: clinic.id, integrationId: integration.id,
      channel: 'whatsapp', externalId: phone, patientId: patient.id,
    });

    const result = await listConversations(sb, clinic.id);
    const item = result.find((c) => c.externalId === phone);
    expect(item?.patientName).toBe('Maria Silva');
  });
});

describe('getConversationWithMessages', () => {
  it('returns conversation + patient + messages ordered by created_at asc', async () => {
    const { clinic, integration } = await makeContext('GetDetail');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const { patient } = await lookupOrCreatePatientByPhone(sb, clinic.id, phone);
    const { conversation } = await getOrCreateConversation(sb, {
      clinicId: clinic.id, integrationId: integration.id,
      channel: 'whatsapp', externalId: phone, patientId: patient.id,
    });
    await addMessage(sb, {
      clinicId: clinic.id, conversationId: conversation.id,
      direction: 'inbound', senderType: 'patient', senderUserId: null,
      contentType: 'text', content: 'msg1', externalId: 'wamid.D-1',
      deliveryStatus: 'delivered',
    });
    await new Promise((r) => setTimeout(r, 10));
    await addMessage(sb, {
      clinicId: clinic.id, conversationId: conversation.id,
      direction: 'outbound', senderType: 'human', senderUserId: null,
      contentType: 'text', content: 'msg2', externalId: 'wamid.D-2',
      deliveryStatus: 'sent',
    });

    const detail = await getConversationWithMessages(sb, clinic.id, conversation.id);

    expect(detail).not.toBeNull();
    expect(detail!.patient?.id).toBe(patient.id);
    expect(detail!.messages.length).toBe(2);
    expect(detail!.messages[0]?.content).toBe('msg1');
    expect(detail!.messages[1]?.content).toBe('msg2');
  });

  it('returns null when conversation does not belong to clinic', async () => {
    const a = await makeContext('GetIsoA');
    const b = await makeContext('GetIsoB');
    const phone = `+5511${Date.now().toString().slice(-9)}`;
    const { conversation } = await getOrCreateConversation(sb, {
      clinicId: b.clinic.id, integrationId: b.integration.id,
      channel: 'whatsapp', externalId: phone, patientId: null,
    });

    const result = await getConversationWithMessages(sb, a.clinic.id, conversation.id);
    expect(result).toBeNull();
  });
});

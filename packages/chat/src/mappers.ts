import type { Conversation, Message, Patient } from '@medina/db';

/**
 * Supabase JS returns raw Postgres column names (snake_case). The Drizzle
 * Patient/Conversation/Message types use camelCase. These mappers translate
 * once at the package boundary so consumers always see camelCase.
 */

type Raw = Record<string, unknown>;

export function mapPatient(row: Raw): Patient {
  return {
    id: row['id'] as string,
    clinicId: row['clinic_id'] as string,
    fullName: row['full_name'] as string,
    preferredName: row['preferred_name'] as string | null,
    phone: row['phone'] as string,
    email: row['email'] as string | null,
    birthDate: row['birth_date'] as string | null,
    gender: row['gender'] as Patient['gender'],
    encryptedCpf: row['encrypted_cpf'] as Buffer | null,
    cpfHash: row['cpf_hash'] as string | null,
    address: row['address'] as Patient['address'],
    emergencyContact: row['emergency_contact'] as Patient['emergencyContact'],
    medicalNotes: row['medical_notes'] as string | null,
    tags: (row['tags'] as string[]) ?? [],
    metadata: (row['metadata'] as Patient['metadata']) ?? {},
    source: row['source'] as Patient['source'],
    createdBy: row['created_by'] as string | null,
    lastContactAt: row['last_contact_at'] ? new Date(row['last_contact_at'] as string) : null,
    deletedAt: row['deleted_at'] ? new Date(row['deleted_at'] as string) : null,
    createdAt: new Date(row['created_at'] as string),
    updatedAt: new Date(row['updated_at'] as string),
  };
}

export function mapConversation(row: Raw): Conversation {
  return {
    id: row['id'] as string,
    clinicId: row['clinic_id'] as string,
    patientId: row['patient_id'] as string | null,
    integrationId: row['integration_id'] as string,
    channel: row['channel'] as Conversation['channel'],
    externalId: row['external_id'] as string,
    state: row['state'] as Conversation['state'],
    assignedUserId: row['assigned_user_id'] as string | null,
    aiEnabled: (row['ai_enabled'] as boolean) ?? true,
    lastMessageAt: row['last_message_at'] ? new Date(row['last_message_at'] as string) : null,
    lastMessagePreview: row['last_message_preview'] as string | null,
    lastInboundAt: row['last_inbound_at'] ? new Date(row['last_inbound_at'] as string) : null,
    lastOutboundAt: row['last_outbound_at'] ? new Date(row['last_outbound_at'] as string) : null,
    unreadCount: (row['unread_count'] as number) ?? 0,
    tags: (row['tags'] as string[]) ?? [],
    metadata: (row['metadata'] as Conversation['metadata']) ?? {},
    pinned: (row['pinned'] as boolean) ?? false,
    archivedAt: row['archived_at'] ? new Date(row['archived_at'] as string) : null,
    resolvedAt: row['resolved_at'] ? new Date(row['resolved_at'] as string) : null,
    resolvedBy: row['resolved_by'] as string | null,
    deletedAt: row['deleted_at'] ? new Date(row['deleted_at'] as string) : null,
    createdAt: new Date(row['created_at'] as string),
    updatedAt: new Date(row['updated_at'] as string),
  };
}

export function mapMessage(row: Raw): Message {
  return {
    id: row['id'] as string,
    conversationId: row['conversation_id'] as string,
    clinicId: row['clinic_id'] as string,
    direction: row['direction'] as Message['direction'],
    senderType: row['sender_type'] as Message['senderType'],
    senderUserId: row['sender_user_id'] as string | null,
    contentType: row['content_type'] as Message['contentType'],
    content: row['content'] as string | null,
    mediaUrl: row['media_url'] as string | null,
    mediaMetadata: row['media_metadata'] as Message['mediaMetadata'],
    templateName: row['template_name'] as string | null,
    templateVariables: row['template_variables'] as Message['templateVariables'],
    externalId: row['external_id'] as string | null,
    deliveryStatus: row['delivery_status'] as Message['deliveryStatus'],
    deliveryError: row['delivery_error'] as string | null,
    outboxStatus: row['outbox_status'] as Message['outboxStatus'],
    aiMetadata: row['ai_metadata'] as Message['aiMetadata'],
    agentConfigId: row['agent_config_id'] as string | null,
    inReplyTo: row['in_reply_to'] as string | null,
    createdAt: new Date(row['created_at'] as string),
  };
}

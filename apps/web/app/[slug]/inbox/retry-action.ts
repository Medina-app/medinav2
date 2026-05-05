'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getTenantContext, getSupabaseServerClient } from '@medina/auth';
import { inngest } from '@/lib/inngest/client';

const RetrySchema = z.object({
  messageId: z.string().uuid(),
});

export type RetryMessageResult = { ok: true } | { error: string };

/**
 * Resets a failed outbound message back to pending and re-dispatches the
 * Inngest event so the worker tries again. Used by the "Retentar" button
 * in MessageBubble.
 *
 * Idempotency: the original event id `outbound:${messageId}` would be
 * deduped by Inngest after the first run, so retries use a suffix
 * `outbound:${messageId}:retry-${timestamp}` to escape the dedup window.
 *
 * Cross-tenant safety: same pattern as sendMessageAction — fetch by
 * id only (RLS-scoped via server client), then explicitly verify
 * clinic_id matches ctx.clinicId. We also intentionally return the
 * generic 'not found' error for cross-tenant rejection so we don't
 * leak existence of the row in another clinic.
 */
export async function retryFailedMessageAction(input: {
  messageId: string;
}): Promise<RetryMessageResult> {
  const parsed = RetrySchema.safeParse(input);
  if (!parsed.success) return { error: 'ID de mensagem inválido.' };

  const ctx = await getTenantContext();
  const sb = await getSupabaseServerClient();

  const { data: msg, error: selErr } = await sb
    .from('messages')
    .select('id, clinic_id, conversation_id, outbox_status')
    .eq('id', parsed.data.messageId)
    .maybeSingle();
  if (selErr) return { error: `Falha ao buscar mensagem: ${selErr.message}` };
  if (!msg) return { error: 'Mensagem não encontrada.' };
  if ((msg.clinic_id as string) !== ctx.clinicId) {
    return { error: 'Mensagem não encontrada.' };
  }
  if (msg.outbox_status !== 'failed') {
    return { error: 'Mensagem não está em estado falho.' };
  }

  const { error: updErr } = await sb
    .from('messages')
    .update({
      outbox_status: 'pending',
      delivery_error: null,
      last_error_at: null,
      retry_count: 0,
    })
    .eq('id', msg.id as string);
  if (updErr) return { error: `Falha ao resetar mensagem: ${updErr.message}` };

  await inngest.send({
    name: 'chat/message.outbound',
    id: `outbound:${msg.id}:retry-${Date.now()}`,
    data: {
      messageId: msg.id as string,
      clinicId: ctx.clinicId,
      conversationId: msg.conversation_id as string,
    },
  });

  revalidatePath(`/${ctx.clinicSlug}/inbox`);
  return { ok: true };
}

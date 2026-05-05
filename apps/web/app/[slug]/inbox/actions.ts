'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getTenantContext, getSupabaseServerClient } from '@medina/auth';
import { queueOutboundMessage } from '@medina/chat';
import { inngest } from '@/lib/inngest/client';

const SendSchema = z.object({
  conversationId: z.string().uuid(),
  content: z.string().min(1).max(4096),
});

export type SendMessageResult =
  | { ok: true; messageId: string }
  | { error: string };

/**
 * CHAT-2: queues an outbound message via the outbox pattern. Returns
 * immediately after INSERTing the row and dispatching the Inngest event;
 * the actual Kapso POST happens in the worker (process-outbound-message),
 * with retries managed by Inngest.
 *
 * Cross-clinic guard W1 (CHAT-1) is preserved — RLS allows multi-clinic
 * admins to read conversations across all their memberships, so we still
 * check that the conversation's clinic_id matches the URL-resolved
 * ctx.clinicId before queueing.
 */
export async function sendMessageAction(input: {
  conversationId: string;
  content: string;
}): Promise<SendMessageResult> {
  const parsed = SendSchema.safeParse(input);
  if (!parsed.success) return { error: 'Mensagem inválida.' };

  const ctx = await getTenantContext();
  const sb = await getSupabaseServerClient();

  const { data: conv, error: convErr } = await sb
    .from('conversations')
    .select('id, clinic_id')
    .eq('id', parsed.data.conversationId)
    .is('deleted_at', null)
    .maybeSingle();
  if (convErr) return { error: `Falha ao buscar conversa: ${convErr.message}` };
  if (!conv) return { error: 'Conversa não encontrada.' };

  if ((conv.clinic_id as string) !== ctx.clinicId) {
    return { error: 'Conversa de outra clínica.' };
  }

  try {
    const { messageId } = await queueOutboundMessage(
      sb,
      inngest.send.bind(inngest),
      {
        clinicId: ctx.clinicId,
        conversationId: conv.id as string,
        content: parsed.data.content,
        senderUserId: ctx.user.id,
      },
    );

    revalidatePath(`/${ctx.clinicSlug}/inbox`);
    return { ok: true, messageId };
  } catch (e) {
    return { error: `Falha ao enfileirar mensagem: ${(e as Error).message}` };
  }
}

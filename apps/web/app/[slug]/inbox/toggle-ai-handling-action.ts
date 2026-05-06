'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getTenantContext, getSupabaseServerClient } from '@medina/auth';

const Schema = z.object({
  conversationId: z.string().uuid(),
  newState: z.enum(['ai_handling', 'waiting_human']),
});

export type ToggleAiHandlingResult =
  | { ok: true }
  | { error: string };

/**
 * Toggles a conversation between IA-driven and human-driven handling.
 * Goes through the transition_conversation_state RPC (defined in
 * 0005_chat.sql) which validates the state transition + writes an
 * audit_logs entry. Cross-tenant guard: explicit clinic_id check on the
 * loaded conversation row before invoking the RPC.
 */
export async function toggleAiHandlingAction(input: {
  conversationId: string;
  newState: 'ai_handling' | 'waiting_human';
}): Promise<ToggleAiHandlingResult> {
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { error: 'Entrada inválida.' };

  const ctx = await getTenantContext();
  const sb = await getSupabaseServerClient();

  const { data: conv } = await sb
    .from('conversations')
    .select('clinic_id')
    .eq('id', parsed.data.conversationId)
    .maybeSingle();
  if (!conv || (conv as { clinic_id: string }).clinic_id !== ctx.clinicId) {
    return { error: 'Conversa não encontrada.' };
  }

  const reason = parsed.data.newState === 'ai_handling' ? 'human_returned_to_ai' : 'human_paused_ai';

  const { error } = await sb.rpc('transition_conversation_state', {
    p_conversation_id: parsed.data.conversationId,
    p_new_state: parsed.data.newState,
    p_reason: reason,
  });
  if (error) return { error: error.message };

  revalidatePath(`/${ctx.clinicSlug}/inbox`);
  return { ok: true };
}

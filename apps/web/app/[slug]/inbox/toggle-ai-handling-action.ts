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

  // PR-A #13: pass 4 args explicitly to hit the 4-arg overload (Postgres
  // resolves overloads by exact arity). Pausing IA → escalated_via='manual'
  // atomically. Returning to IA → null (the function force-clears the flag
  // on 'ai_handling' regardless, but we send null for arity consistency).
  const escalatedViaValue: 'manual' | null =
    parsed.data.newState === 'waiting_human' ? 'manual' : null;

  const { error } = await sb.rpc('transition_conversation_state', {
    conv_id: parsed.data.conversationId,
    new_state: parsed.data.newState,
    reason,
    escalated_via_value: escalatedViaValue,
  });
  if (error) return { error: error.message };

  revalidatePath(`/${ctx.clinicSlug}/inbox`);
  return { ok: true };
}

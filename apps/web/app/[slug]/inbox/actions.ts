'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getTenantContext, getSupabaseServerClient } from '@medina/auth';
import { addMessage } from '@medina/chat';

const SendSchema = z.object({
  conversationId: z.string().uuid(),
  content: z.string().min(1).max(4096),
});

export type SendMessageResult = { ok: true } | { error: string };

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
    .select('id, clinic_id, integration_id, external_id')
    .eq('id', parsed.data.conversationId)
    .is('deleted_at', null)
    .maybeSingle();
  if (convErr) return { error: `Falha ao buscar conversa: ${convErr.message}` };
  if (!conv) return { error: 'Conversa não encontrada.' };

  // Multi-clinic admins can read conversations across all their memberships
  // via RLS. Without this guard, sending from clinic A's URL while passing
  // clinic B's conversation_id would dispatch via B's Kapso credentials
  // before the addMessage trigger blocks the cross-clinic write — leaving a
  // "ghost" message delivered to the patient with no DB record.
  if ((conv.clinic_id as string) !== ctx.clinicId) {
    return { error: 'Conversa de outra clínica.' };
  }

  // Use the server client (authenticated user JWT) so get_integration_credential's
  // internal has_clinic_role(...) check resolves auth.uid() to a real user.
  // Service-role admin client would yield auth.uid() = NULL → access denied.
  // Explicit column list avoids the column-level grant on webhook_secret /
  // encrypted_credentials revoked from authenticated in 0010_secure_webhook_secret.sql.
  const { data: integ, error: integErr } = await sb
    .from('clinic_integrations')
    .select('id, status, config')
    .eq('id', conv.integration_id as string)
    .is('deleted_at', null)
    .maybeSingle();
  if (integErr) return { error: `Falha ao buscar integração: ${integErr.message}` };
  if (!integ) return { error: 'Integração não encontrada.' };
  if (integ.status !== 'active') return { error: 'Integração WhatsApp inativa.' };

  const cfg = (integ.config ?? {}) as Record<string, unknown>;
  const phoneNumberId = cfg['phone_number_id'] as string | undefined;
  if (!phoneNumberId) {
    return {
      error:
        'phone_number_id ainda não capturado — receba 1 mensagem inbound primeiro pra inicializar.',
    };
  }

  const { data: credJson, error: credErr } = await sb.rpc('get_integration_credential', {
    p_integration_id: integ.id as string,
  });
  if (credErr) return { error: `Falha ao decriptar credenciais: ${credErr.message}` };
  if (!credJson) return { error: 'Credenciais Kapso não disponíveis.' };

  let creds: { api_key: string };
  try {
    creds = JSON.parse(credJson as string) as { api_key: string };
  } catch {
    return { error: 'Credenciais malformadas.' };
  }

  let res: Response;
  try {
    res = await fetch(
      `https://api.kapso.ai/meta/whatsapp/v24.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: { 'X-API-Key': creds.api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: conv.external_id,
          type: 'text',
          text: { body: parsed.data.content },
        }),
      },
    );
  } catch (e) {
    return { error: `Erro de rede ao chamar Kapso: ${(e as Error).message}` };
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { error: `Kapso retornou ${res.status}: ${txt.slice(0, 200)}` };
  }

  const json = (await res.json().catch(() => null)) as {
    messages?: Array<{ id: string }>;
  } | null;
  const externalId = json?.messages?.[0]?.id ?? null;

  await addMessage(sb, {
    clinicId: ctx.clinicId,
    conversationId: conv.id as string,
    direction: 'outbound',
    senderType: 'human',
    senderUserId: ctx.user.id,
    contentType: 'text',
    content: parsed.data.content,
    externalId,
    deliveryStatus: 'sent',
  });

  revalidatePath(`/${ctx.clinicSlug}/inbox`);
  return { ok: true };
}

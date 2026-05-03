'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import {
  getTenantContext,
  getSupabaseServerClient,
  getSupabaseAdminClient,
} from '@medina/auth';
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

  const admin = getSupabaseAdminClient();

  const { data: integ, error: integErr } = await admin
    .from('clinic_integrations')
    .select('*')
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

  const { data: credJson, error: credErr } = await admin.rpc('get_integration_credential', {
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

  await addMessage(admin, {
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

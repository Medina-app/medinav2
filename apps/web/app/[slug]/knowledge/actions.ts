'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getTenantContext, getSupabaseServerClient } from '@medina/auth';

const DeleteSchema = z.object({
  documentId: z.string().uuid(),
});

export type DeleteKbDocumentResult = { ok: true } | { error: string };

/**
 * AI-3.5a: hard delete de knowledge_document.
 *
 * Hard (não soft via archived_at) por design — search_kb internal RPC NÃO
 * filtra archived_at; deixar chunks órfãos os tornaria ainda buscáveis pelo
 * agente. Cascade do FK em knowledge_chunks.document_id remove chunks
 * automaticamente. UI confirma "ação permanente" antes da chamada.
 *
 * Cross-tenant guard: SELECT clinic_id antes do DELETE; mismatch → erro
 * sem efeito. RLS authenticated DELETE policy adicionalmente filtra por
 * has_clinic_role(admin|owner) — defesa em profundidade.
 *
 * Audit: log via `admin.kb.delete` em audit_logs com clinic_id +
 * document_id pra trail de quem deletou.
 */
export async function deleteKbDocumentAction(input: {
  documentId: string;
}): Promise<DeleteKbDocumentResult> {
  const parsed = DeleteSchema.safeParse(input);
  if (!parsed.success) return { error: 'Entrada inválida.' };

  const ctx = await getTenantContext();
  const sb = await getSupabaseServerClient();

  // Cross-tenant guard antes de DELETE.
  const { data: doc } = await sb
    .from('knowledge_documents')
    .select('clinic_id')
    .eq('id', parsed.data.documentId)
    .maybeSingle();

  if (!doc || (doc as { clinic_id: string }).clinic_id !== ctx.clinicId) {
    return { error: 'Documento não encontrado.' };
  }

  const { error: delErr } = await sb
    .from('knowledge_documents')
    .delete()
    .eq('id', parsed.data.documentId);

  if (delErr) return { error: delErr.message };

  // Audit complementar (best-effort — não falha o delete se audit falhar).
  await sb.from('audit_logs').insert({
    clinic_id: ctx.clinicId,
    user_id: ctx.user.id,
    action: 'admin.kb.delete',
    resource: 'knowledge_documents',
    resource_id: parsed.data.documentId,
    metadata: { source: 'admin_ui' },
  });

  revalidatePath(`/${ctx.clinicSlug}/knowledge`);
  return { ok: true };
}

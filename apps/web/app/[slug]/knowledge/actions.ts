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
  // CR review #2: distingue erro de SELECT (RLS/rede/config) de "não
  // encontrado" — masca operational error como not-found dificulta debug.
  const { data: doc, error: docErr } = await sb
    .from('knowledge_documents')
    .select('clinic_id')
    .eq('id', parsed.data.documentId)
    .maybeSingle();

  if (docErr) return { error: 'Falha ao validar documento.' };

  if (!doc || (doc as { clinic_id: string }).clinic_id !== ctx.clinicId) {
    return { error: 'Documento não encontrado.' };
  }

  // CR review #3: TOCTOU defense — DELETE filtrado também por clinic_id.
  // Caso entre o SELECT acima e este DELETE alguma transação alterar
  // ownership do row, defense in depth garante que admin clinic-A não
  // pode acidentalmente apagar doc clinic-B mesmo sob race.
  const { error: delErr } = await sb
    .from('knowledge_documents')
    .delete()
    .eq('id', parsed.data.documentId)
    .eq('clinic_id', ctx.clinicId);

  if (delErr) return { error: delErr.message };

  // Audit complementar — best-effort por design: o DELETE já aconteceu e é
  // irreversível (cascade FK). Throw em audit failure deixaria UX confusa
  // (admin acharia que delete falhou quando na verdade foi). Capturamos
  // erro pra observability via console.warn — falha de audit é incidente
  // mas não bloqueia o fluxo.
  const { error: auditErr } = await sb.from('audit_logs').insert({
    clinic_id: ctx.clinicId,
    user_id: ctx.user.id,
    action: 'admin.kb.delete',
    resource: 'knowledge_documents',
    resource_id: parsed.data.documentId,
    metadata: { source: 'admin_ui' },
  });
  if (auditErr) {
    console.warn(
      `kb.delete audit failed (delete succeeded but audit not recorded): clinic=${ctx.clinicId} doc=${parsed.data.documentId} err=${auditErr.message}`,
    );
  }

  revalidatePath(`/${ctx.clinicSlug}/knowledge`);
  return { ok: true };
}

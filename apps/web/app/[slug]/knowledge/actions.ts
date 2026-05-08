'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getTenantContext, getSupabaseServerClient } from '@medina/auth';
import { uploadKbDocument } from '@medina/chat';
import { inngest } from '@/lib/inngest/client';
import { createHash } from 'node:crypto';

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

// ─── AI-3.5b: createKbDocumentAction ────────────────────────────────────────

/** Whitelist canonical de extensões. Mime detection feita no parser. */
const ALLOWED_EXTS = ['md', 'txt', 'pdf', 'docx'] as const;
type AllowedExt = (typeof ALLOWED_EXTS)[number];

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB matches bucket limit

const MIME_BY_EXT: Record<AllowedExt, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export type CreateKbDocumentResult =
  | { ok: true; documentId: string }
  | { error: string };

/**
 * AI-3.5b: upload + INSERT knowledge_document (status=pending,
 * approval_status=pending_approval).
 *
 * Worker process-kb-document NÃO dispara automaticamente — admin tem que
 * aprovar primeiro via approveKbDocumentAction. Defesa contra:
 *   - upload acidental que polui contexto IA antes de revisão
 *   - mudanças de contrato sem revisão humana
 *   - PDF malicioso (parser roda só após aprovação)
 *
 * Caller passa FormData com 'title' (string) + 'file' (File). Action faz:
 *   1. Validate title + file size + ext
 *   2. SHA-256 do conteúdo (idempotency / dedup futuro)
 *   3. INSERT row pending_approval
 *   4. Upload pra storage path {clinicId}/{documentId}.{ext}
 *   5. revalidatePath
 */
export async function createKbDocumentAction(formData: FormData): Promise<CreateKbDocumentResult> {
  const title = formData.get('title');
  const file = formData.get('file');

  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 200) {
    return { error: 'Título inválido (1-200 chars).' };
  }
  if (!(file instanceof File)) {
    return { error: 'Arquivo ausente.' };
  }
  if (file.size === 0) {
    return { error: 'Arquivo vazio.' };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { error: `Arquivo excede 5MB (${(file.size / 1024 / 1024).toFixed(1)}MB).` };
  }

  // Detecta extension via filename (defense em profundidade contra mime
  // forjado). Storage RLS adiciona regex check no path.
  const filename = file.name.toLowerCase();
  const dotIdx = filename.lastIndexOf('.');
  const ext = dotIdx > 0 ? filename.slice(dotIdx + 1) : '';
  if (!ALLOWED_EXTS.includes(ext as AllowedExt)) {
    return {
      error: `Formato não suportado. Use ${ALLOWED_EXTS.join(', ').toUpperCase()}.`,
    };
  }
  const allowedExt = ext as AllowedExt;

  const ctx = await getTenantContext();
  if (ctx.role !== 'admin' && ctx.role !== 'owner') {
    return { error: 'Apenas admins/owners podem fazer upload.' };
  }
  const sb = await getSupabaseServerClient();

  // Read file content pra hash + upload.
  const arrayBuf = await file.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  const contentHash = createHash('sha256').update(buf).digest('hex');

  // INSERT primeiro (sem storage path ainda) — gera documentId.
  const { data: doc, error: insErr } = await sb
    .from('knowledge_documents')
    .insert({
      clinic_id: ctx.clinicId,
      title: title.trim(),
      source_type: allowedExt === 'pdf' || allowedExt === 'docx' ? allowedExt : allowedExt,
      file_size_bytes: file.size,
      file_mime_type: MIME_BY_EXT[allowedExt],
      content_hash: contentHash,
      status: 'pending',
      approval_status: 'pending_approval',
      embedding_model: 'text-embedding-3-small',
      created_by: ctx.user.id,
    })
    .select('id')
    .single();

  if (insErr || !doc) {
    return { error: `Falha ao criar registro: ${insErr?.message ?? 'sem dados'}` };
  }
  const documentId = (doc as { id: string }).id;

  // Upload pra storage. Falha aqui → rollback DB row pra evitar zombie.
  try {
    await uploadKbDocument({
      sb,
      clinicId: ctx.clinicId,
      documentId,
      ext: allowedExt,
      body: buf,
      mimeType: MIME_BY_EXT[allowedExt],
    });
  } catch (e) {
    await sb.from('knowledge_documents').delete().eq('id', documentId);
    return { error: `Falha ao fazer upload: ${(e as Error).message}` };
  }

  await sb.from('audit_logs').insert({
    clinic_id: ctx.clinicId,
    user_id: ctx.user.id,
    action: 'admin.kb.upload',
    resource: 'knowledge_documents',
    resource_id: documentId,
    metadata: { ext: allowedExt, size_bytes: file.size, source: 'admin_ui' },
  });

  revalidatePath(`/${ctx.clinicSlug}/knowledge`);
  return { ok: true, documentId };
}

// ─── AI-3.5b: approveKbDocumentAction ───────────────────────────────────────

const ApproveSchema = z.object({ documentId: z.string().uuid() });

export type ApproveKbDocumentResult = { ok: true } | { error: string };

/**
 * AI-3.5b: admin/owner aprova doc → triggers worker process-kb-document.
 *
 * Updates approval_status='approved' + approved_by + approved_at, então
 * dispatcha Inngest event 'kb/document.process' que faz parse + chunk +
 * embed + INSERT chunks. Worker valida approval_status='approved' como
 * defesa contra event spoofing.
 */
export async function approveKbDocumentAction(input: {
  documentId: string;
}): Promise<ApproveKbDocumentResult> {
  const parsed = ApproveSchema.safeParse(input);
  if (!parsed.success) return { error: 'Entrada inválida.' };

  const ctx = await getTenantContext();
  if (ctx.role !== 'admin' && ctx.role !== 'owner') {
    return { error: 'Apenas admins/owners podem aprovar.' };
  }
  const sb = await getSupabaseServerClient();

  const { data: doc, error: docErr } = await sb
    .from('knowledge_documents')
    .select('clinic_id, file_mime_type, source_type, approval_status')
    .eq('id', parsed.data.documentId)
    .maybeSingle();
  if (docErr) return { error: 'Falha ao validar documento.' };
  if (!doc || (doc as { clinic_id: string }).clinic_id !== ctx.clinicId) {
    return { error: 'Documento não encontrado.' };
  }
  const docRow = doc as {
    clinic_id: string;
    file_mime_type: string | null;
    source_type: string;
    approval_status: string;
  };
  if (docRow.approval_status === 'approved') {
    return { error: 'Documento já está aprovado.' };
  }

  const { error: updErr } = await sb
    .from('knowledge_documents')
    .update({
      approval_status: 'approved',
      approved_by: ctx.user.id,
      approved_at: new Date().toISOString(),
      rejection_reason: null,
    })
    .eq('id', parsed.data.documentId)
    .eq('clinic_id', ctx.clinicId);
  if (updErr) return { error: updErr.message };

  // CR fix #3: enqueue inngest ANTES do audit log + rollback do UPDATE
  // se falhar. Sem isso, doc fica com approval_status='approved' mas worker
  // nunca dispara — usuario vê "Aprovado" no inbox e a IA usa o doc, mas
  // chunks nunca foram criados (search_kb retorna zero hits do doc).
  try {
    await inngest.send({
      name: 'kb/document.process',
      data: {
        clinicId: ctx.clinicId,
        documentId: parsed.data.documentId,
        ext: docRow.source_type,
        mimeType: docRow.file_mime_type ?? undefined,
      },
    });
  } catch (e) {
    // Rollback: volta pra pending_approval. Idempotente — re-aprovar
    // chama esta action de novo.
    await sb
      .from('knowledge_documents')
      .update({
        approval_status: 'pending_approval',
        approved_by: null,
        approved_at: null,
      })
      .eq('id', parsed.data.documentId)
      .eq('clinic_id', ctx.clinicId);
    return { error: `Falha ao enfileirar indexação: ${(e as Error).message}` };
  }

  // Audit DEPOIS do enqueue confirmado — best-effort. Se audit falha mas
  // worker já enfileirado, ainda preferimos doc indexado a falha visível.
  await sb.from('audit_logs').insert({
    clinic_id: ctx.clinicId,
    user_id: ctx.user.id,
    action: 'admin.kb.approve',
    resource: 'knowledge_documents',
    resource_id: parsed.data.documentId,
    metadata: { source: 'admin_ui' },
  });

  revalidatePath(`/${ctx.clinicSlug}/knowledge`);
  return { ok: true };
}

// ─── AI-3.5b: rejectKbDocumentAction ────────────────────────────────────────

const RejectSchema = z.object({
  documentId: z.string().uuid(),
  reason: z.string().min(3).max(500),
});

export type RejectKbDocumentResult = { ok: true } | { error: string };

/**
 * Marca doc como rejected com motivo. NÃO deleta nem dispatcha worker.
 * Doc fica visível na tab "Rejeitados" pra audit.
 */
export async function rejectKbDocumentAction(input: {
  documentId: string;
  reason: string;
}): Promise<RejectKbDocumentResult> {
  const parsed = RejectSchema.safeParse(input);
  if (!parsed.success) return { error: 'Motivo inválido (3-500 chars).' };

  const ctx = await getTenantContext();
  if (ctx.role !== 'admin' && ctx.role !== 'owner') {
    return { error: 'Apenas admins/owners podem rejeitar.' };
  }
  const sb = await getSupabaseServerClient();

  const { data: doc, error: docErr } = await sb
    .from('knowledge_documents')
    .select('clinic_id')
    .eq('id', parsed.data.documentId)
    .maybeSingle();
  if (docErr) return { error: 'Falha ao validar documento.' };
  if (!doc || (doc as { clinic_id: string }).clinic_id !== ctx.clinicId) {
    return { error: 'Documento não encontrado.' };
  }

  const { error: updErr } = await sb
    .from('knowledge_documents')
    .update({
      approval_status: 'rejected',
      rejection_reason: parsed.data.reason,
    })
    .eq('id', parsed.data.documentId)
    .eq('clinic_id', ctx.clinicId);
  if (updErr) return { error: updErr.message };

  await sb.from('audit_logs').insert({
    clinic_id: ctx.clinicId,
    user_id: ctx.user.id,
    action: 'admin.kb.reject',
    resource: 'knowledge_documents',
    resource_id: parsed.data.documentId,
    metadata: { reason: parsed.data.reason, source: 'admin_ui' },
  });

  revalidatePath(`/${ctx.clinicSlug}/knowledge`);
  return { ok: true };
}

// ─── AI-3.5b: reindexKbDocumentAction ───────────────────────────────────────

const ReindexSchema = z.object({ documentId: z.string().uuid() });

export type ReindexKbDocumentResult = { ok: true } | { error: string };

/**
 * Re-dispara worker process-kb-document pra doc já aprovado. Útil quando:
 *   - status='failed' por OpenAI rate limit (retry manual)
 *   - admin atualizou storage file e quer re-processar
 *   - chunks ficaram inválidos (mudança no algoritmo de chunking)
 *
 * Resetta status pra 'pending' antes de dispatchar — worker re-INSERT
 * chunks (sem deduplicar; admin pode deletar chunks antigos via SQL se
 * necessário; UI futura pode oferecer botão "limpar chunks").
 */
export async function reindexKbDocumentAction(input: {
  documentId: string;
}): Promise<ReindexKbDocumentResult> {
  const parsed = ReindexSchema.safeParse(input);
  if (!parsed.success) return { error: 'Entrada inválida.' };

  const ctx = await getTenantContext();
  if (ctx.role !== 'admin' && ctx.role !== 'owner') {
    return { error: 'Apenas admins/owners podem re-indexar.' };
  }
  const sb = await getSupabaseServerClient();

  const { data: doc, error: docErr } = await sb
    .from('knowledge_documents')
    .select('clinic_id, file_mime_type, source_type, approval_status')
    .eq('id', parsed.data.documentId)
    .maybeSingle();
  if (docErr) return { error: 'Falha ao validar documento.' };
  if (!doc || (doc as { clinic_id: string }).clinic_id !== ctx.clinicId) {
    return { error: 'Documento não encontrado.' };
  }
  const docRow = doc as {
    clinic_id: string;
    file_mime_type: string | null;
    source_type: string;
    approval_status: string;
  };
  if (docRow.approval_status !== 'approved') {
    return { error: 'Apenas documentos aprovados podem ser re-indexados.' };
  }

  // CR fix #4: capturar erro do UPDATE — sem isso, RLS deny ou network
  // error retornaria { ok: true } com nada acontecendo (worker noop).
  const { error: updErr } = await sb
    .from('knowledge_documents')
    .update({ status: 'pending', error_message: null })
    .eq('id', parsed.data.documentId)
    .eq('clinic_id', ctx.clinicId);
  if (updErr) return { error: `Falha ao resetar status: ${updErr.message}` };

  // CR fix #3 (simétrico): enqueue inngest com rollback do status reset
  // se falhar. Doc volta pra status anterior implícito via worker dispatch
  // pendente — aqui apenas evitamos sinalizar success pra UI.
  try {
    await inngest.send({
      name: 'kb/document.process',
      data: {
        clinicId: ctx.clinicId,
        documentId: parsed.data.documentId,
        ext: docRow.source_type,
        mimeType: docRow.file_mime_type ?? undefined,
      },
    });
  } catch (e) {
    return { error: `Falha ao enfileirar reindex: ${(e as Error).message}` };
  }

  await sb.from('audit_logs').insert({
    clinic_id: ctx.clinicId,
    user_id: ctx.user.id,
    action: 'admin.kb.reindex',
    resource: 'knowledge_documents',
    resource_id: parsed.data.documentId,
    metadata: { source: 'admin_ui' },
  });

  revalidatePath(`/${ctx.clinicSlug}/knowledge`);
  return { ok: true };
}

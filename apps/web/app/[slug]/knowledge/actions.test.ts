import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const tenantCtx = {
  user: { id: 'user-1', email: 'a@b.com' },
  clinicId: 'clinic-1',
  clinicSlug: 'demo',
  clinicName: 'Demo',
  role: 'admin' as const,
};

const mockGetTenantContext = vi.fn();
const mockGetSupabaseServerClient = vi.fn();

vi.mock('@medina/auth', () => ({
  getTenantContext: () => mockGetTenantContext(),
  getSupabaseServerClient: () => mockGetSupabaseServerClient(),
}));

const mockInngestSend = vi.fn().mockResolvedValue({ ids: ['evt-1'] });
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));

import {
  deleteKbDocumentAction,
  approveKbDocumentAction,
  rejectKbDocumentAction,
  reindexKbDocumentAction,
} from './actions';

/**
 * Mock supporting:
 *   sb.from('knowledge_documents').select('clinic_id').eq('id', x).maybeSingle()
 *   sb.from('knowledge_documents').delete().eq('id', x)
 *   sb.from('audit_logs').insert({...})
 */
function buildSupabase(opts: {
  document?: Record<string, unknown> | null;
  selectError?: string;
  deleteError?: string;
  updateError?: string;
  auditError?: string;
}) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: opts.selectError ? null : opts.document ?? null,
    error: opts.selectError ? { message: opts.selectError } : null,
  });
  const eqSelect = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq: eqSelect });

  // DELETE chain é .delete().eq('id', X).eq('clinic_id', Y)
  const eqDeleteFinal = vi.fn().mockResolvedValue({
    error: opts.deleteError ? { message: opts.deleteError } : null,
  });
  const eqDelete = vi.fn().mockReturnValue({ eq: eqDeleteFinal });
  const deleteFn = vi.fn().mockReturnValue({ eq: eqDelete });

  // UPDATE chain é .update(payload).eq('id', X).eq('clinic_id', Y)
  const updateCalls: Array<{ table: string; payload: unknown }> = [];
  const eqUpdateFinal = vi.fn().mockResolvedValue({
    error: opts.updateError ? { message: opts.updateError } : null,
  });
  const eqUpdate = vi.fn().mockReturnValue({ eq: eqUpdateFinal });
  const updateFn = vi.fn((payload: unknown) => {
    updateCalls.push({ table: 'knowledge_documents', payload });
    return { eq: eqUpdate };
  });

  const insertCalls: Array<{ table: string; payload: unknown }> = [];
  const insert = vi.fn((payload: unknown) => {
    insertCalls.push({ table: 'audit_logs', payload });
    return Promise.resolve({
      error: opts.auditError ? { message: opts.auditError } : null,
    });
  });

  const from = vi.fn((table: string) => {
    if (table === 'knowledge_documents') return { select, delete: deleteFn, update: updateFn };
    if (table === 'audit_logs') return { insert };
    throw new Error(`unmocked table ${table}`);
  });

  return {
    client: { from } as unknown,
    fromMock: from,
    eqDelete,
    eqDeleteFinal,
    updateFn,
    eqUpdate,
    eqUpdateFinal,
    updateCalls,
    insertCalls,
  };
}

beforeEach(() => {
  mockGetTenantContext.mockResolvedValue(tenantCtx);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('deleteKbDocumentAction', () => {
  it('rejeita non-uuid documentId via Zod', async () => {
    const result = await deleteKbDocumentAction({ documentId: 'not-a-uuid' });
    expect(result).toEqual({ error: 'Entrada inválida.' });
  });

  it('cross-tenant: rejeita document de outra clinica e NÃO deleta', async () => {
    const sb = buildSupabase({ document: { clinic_id: 'clinic-OTHER' } });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await deleteKbDocumentAction({
      documentId: '11111111-1111-1111-1111-111111111111',
    });

    expect(result).toEqual({ error: 'Documento não encontrado.' });
    expect(sb.eqDelete).not.toHaveBeenCalled();
  });

  it('retorna erro quando documento não existe', async () => {
    const sb = buildSupabase({ document: null });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await deleteKbDocumentAction({
      documentId: '11111111-1111-1111-1111-111111111111',
    });
    expect(result).toEqual({ error: 'Documento não encontrado.' });
  });

  it('deleta hard (cascade chunks via FK) quando documento pertence à clinic', async () => {
    const sb = buildSupabase({ document: { clinic_id: 'clinic-1' } });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await deleteKbDocumentAction({
      documentId: '11111111-1111-1111-1111-111111111111',
    });

    expect(result).toEqual({ ok: true });
    // Primeiro eq() filtra por id; segundo eq() filtra por clinic_id (TOCTOU defense).
    expect(sb.eqDelete).toHaveBeenCalledWith('id', '11111111-1111-1111-1111-111111111111');
    expect(sb.eqDeleteFinal).toHaveBeenCalledWith('clinic_id', 'clinic-1');
  });

  it('audita action=admin.kb.delete com clinic_id + documentId', async () => {
    const sb = buildSupabase({ document: { clinic_id: 'clinic-1' } });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    await deleteKbDocumentAction({
      documentId: '11111111-1111-1111-1111-111111111111',
    });

    const audit = sb.insertCalls.find((c) => c.table === 'audit_logs');
    expect(audit).toBeDefined();
    expect(audit!.payload).toMatchObject({
      clinic_id: 'clinic-1',
      action: 'admin.kb.delete',
      resource: 'knowledge_documents',
      resource_id: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('surface erro do Supabase em DELETE (e.g., RLS rejeita)', async () => {
    const sb = buildSupabase({
      document: { clinic_id: 'clinic-1' },
      deleteError: 'permission denied for table knowledge_documents',
    });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await deleteKbDocumentAction({
      documentId: '11111111-1111-1111-1111-111111111111',
    });
    expect(result).toEqual({
      error: 'permission denied for table knowledge_documents',
    });
  });

  it('SELECT error retorna "Falha ao validar documento" (não masca como not-found) (CR review #2)', async () => {
    const sb = buildSupabase({
      selectError: 'connection refused',
    });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await deleteKbDocumentAction({
      documentId: '11111111-1111-1111-1111-111111111111',
    });
    expect(result).toEqual({ error: 'Falha ao validar documento.' });
    expect(sb.eqDelete).not.toHaveBeenCalled();
  });

  // ─── AI-3.5b approval workflow tests ─────────────────────────────────────

  describe('approveKbDocumentAction', () => {
    it('aprova doc + dispatcha Inngest event kb/document.process', async () => {
      const sb = buildSupabase({
        document: {
          clinic_id: 'clinic-1',
          file_mime_type: 'text/markdown',
          source_type: 'md',
          approval_status: 'pending_approval',
        },
      });
      mockGetSupabaseServerClient.mockReturnValue(sb.client);

      const result = await approveKbDocumentAction({
        documentId: '11111111-1111-1111-1111-111111111111',
      });

      expect(result).toEqual({ ok: true });
      const updatePayload = sb.updateCalls[0]?.payload as { approval_status: string };
      expect(updatePayload.approval_status).toBe('approved');
      expect(mockInngestSend).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'kb/document.process',
          data: expect.objectContaining({
            documentId: '11111111-1111-1111-1111-111111111111',
            ext: 'md',
          }),
        }),
      );
    });

    it('cross-tenant: rejeita doc de outra clinic e NÃO dispatcha Inngest', async () => {
      const sb = buildSupabase({
        document: {
          clinic_id: 'clinic-OTHER',
          file_mime_type: 'text/markdown',
          source_type: 'md',
          approval_status: 'pending_approval',
        },
      });
      mockGetSupabaseServerClient.mockReturnValue(sb.client);

      const result = await approveKbDocumentAction({
        documentId: '11111111-1111-1111-1111-111111111111',
      });
      expect(result).toEqual({ error: 'Documento não encontrado.' });
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('rejeita user com role member (apenas admin/owner pode aprovar)', async () => {
      mockGetTenantContext.mockResolvedValueOnce({ ...tenantCtx, role: 'member' });
      const result = await approveKbDocumentAction({
        documentId: '11111111-1111-1111-1111-111111111111',
      });
      expect(result).toEqual({ error: 'Apenas admins/owners podem aprovar.' });
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('rejeita doc já approved (idempotência explícita)', async () => {
      const sb = buildSupabase({
        document: {
          clinic_id: 'clinic-1',
          file_mime_type: 'text/markdown',
          source_type: 'md',
          approval_status: 'approved',
        },
      });
      mockGetSupabaseServerClient.mockReturnValue(sb.client);

      const result = await approveKbDocumentAction({
        documentId: '11111111-1111-1111-1111-111111111111',
      });
      expect(result).toEqual({ error: 'Documento já está aprovado.' });
    });

    it('CR fix #3: inngest.send falha → rollback approval + retorna erro', async () => {
      const sb = buildSupabase({
        document: {
          clinic_id: 'clinic-1',
          file_mime_type: 'text/markdown',
          source_type: 'md',
          approval_status: 'pending_approval',
        },
      });
      mockGetSupabaseServerClient.mockReturnValue(sb.client);
      mockInngestSend.mockRejectedValueOnce(new Error('inngest unreachable'));

      const result = await approveKbDocumentAction({
        documentId: '11111111-1111-1111-1111-111111111111',
      });

      expect(result).toEqual({ error: 'Falha ao enfileirar indexação: inngest unreachable' });
      // 2 UPDATEs: 1º approved, 2º rollback pra pending_approval
      expect(sb.updateCalls.length).toBe(2);
      const rollback = sb.updateCalls[1]?.payload as {
        approval_status: string;
        approved_by: string | null;
      };
      expect(rollback.approval_status).toBe('pending_approval');
      expect(rollback.approved_by).toBeNull();
    });
  });

  describe('rejectKbDocumentAction', () => {
    it('rejeita com motivo + audit log + NÃO dispatcha Inngest', async () => {
      const sb = buildSupabase({ document: { clinic_id: 'clinic-1' } });
      mockGetSupabaseServerClient.mockReturnValue(sb.client);

      const result = await rejectKbDocumentAction({
        documentId: '11111111-1111-1111-1111-111111111111',
        reason: 'conteúdo desatualizado, precisa revisão',
      });

      expect(result).toEqual({ ok: true });
      const updatePayload = sb.updateCalls[0]?.payload as {
        approval_status: string;
        rejection_reason: string;
      };
      expect(updatePayload.approval_status).toBe('rejected');
      expect(updatePayload.rejection_reason).toBe('conteúdo desatualizado, precisa revisão');
      const audit = sb.insertCalls.find(
        (c) =>
          c.table === 'audit_logs' &&
          (c.payload as { action: string }).action === 'admin.kb.reject',
      );
      expect(audit).toBeDefined();
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('zod rejeita reason muito curto (< 3 chars)', async () => {
      const result = await rejectKbDocumentAction({
        documentId: '11111111-1111-1111-1111-111111111111',
        reason: 'no',
      });
      expect(result).toEqual({ error: 'Motivo inválido (3-500 chars).' });
    });

    it('cross-tenant: rejeita doc de outra clinic', async () => {
      const sb = buildSupabase({ document: { clinic_id: 'clinic-OTHER' } });
      mockGetSupabaseServerClient.mockReturnValue(sb.client);
      const result = await rejectKbDocumentAction({
        documentId: '11111111-1111-1111-1111-111111111111',
        reason: 'malicious attempt',
      });
      expect(result).toEqual({ error: 'Documento não encontrado.' });
    });
  });

  describe('reindexKbDocumentAction', () => {
    it('re-indexa doc approved + reset status pending + dispatch Inngest', async () => {
      const sb = buildSupabase({
        document: {
          clinic_id: 'clinic-1',
          file_mime_type: 'text/markdown',
          source_type: 'md',
          approval_status: 'approved',
        },
      });
      mockGetSupabaseServerClient.mockReturnValue(sb.client);

      const result = await reindexKbDocumentAction({
        documentId: '11111111-1111-1111-1111-111111111111',
      });

      expect(result).toEqual({ ok: true });
      const updatePayload = sb.updateCalls[0]?.payload as {
        status: string;
        error_message: null;
      };
      expect(updatePayload.status).toBe('pending');
      expect(updatePayload.error_message).toBeNull();
      expect(mockInngestSend).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'kb/document.process' }),
      );
    });

    it('rejeita doc não-approved (não pode reindexar pending_approval/rejected)', async () => {
      const sb = buildSupabase({
        document: {
          clinic_id: 'clinic-1',
          file_mime_type: 'text/markdown',
          source_type: 'md',
          approval_status: 'pending_approval',
        },
      });
      mockGetSupabaseServerClient.mockReturnValue(sb.client);

      const result = await reindexKbDocumentAction({
        documentId: '11111111-1111-1111-1111-111111111111',
      });
      expect(result).toEqual({ error: 'Apenas documentos aprovados podem ser re-indexados.' });
      expect(mockInngestSend).not.toHaveBeenCalled();
    });

    it('CR fix #4: UPDATE falha → retorna erro + NÃO dispatcha Inngest', async () => {
      const sb = buildSupabase({
        document: {
          clinic_id: 'clinic-1',
          file_mime_type: 'text/markdown',
          source_type: 'md',
          approval_status: 'approved',
        },
        updateError: 'connection terminated',
      });
      mockGetSupabaseServerClient.mockReturnValue(sb.client);

      const result = await reindexKbDocumentAction({
        documentId: '11111111-1111-1111-1111-111111111111',
      });

      expect(result).toEqual({ error: 'Falha ao resetar status: connection terminated' });
      expect(mockInngestSend).not.toHaveBeenCalled();
    });
  });

  it('audit failure NÃO bloqueia delete (best-effort) mas emite console.warn', async () => {
    // Self-review: delete já aconteceu e é irreversível (cascade FK). Throw
    // em audit failure deixaria UX confusa. Capturamos via console.warn pra
    // observability sem propagar erro.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sb = buildSupabase({
      document: { clinic_id: 'clinic-1' },
      auditError: 'audit_logs table down',
    });
    mockGetSupabaseServerClient.mockReturnValue(sb.client);

    const result = await deleteKbDocumentAction({
      documentId: '11111111-1111-1111-1111-111111111111',
    });

    expect(result).toEqual({ ok: true });
    expect(sb.eqDelete).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('audit failed'),
    );
    warnSpy.mockRestore();
  });
});

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

import { deleteKbDocumentAction } from './actions';

/**
 * Mock supporting:
 *   sb.from('knowledge_documents').select('clinic_id').eq('id', x).maybeSingle()
 *   sb.from('knowledge_documents').delete().eq('id', x)
 *   sb.from('audit_logs').insert({...})
 */
function buildSupabase(opts: {
  document?: { clinic_id: string } | null;
  deleteError?: string;
  auditError?: string;
}) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: opts.document ?? null,
    error: null,
  });
  const eqSelect = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq: eqSelect });

  const eqDelete = vi.fn().mockResolvedValue({
    error: opts.deleteError ? { message: opts.deleteError } : null,
  });
  const deleteFn = vi.fn().mockReturnValue({ eq: eqDelete });

  const insertCalls: Array<{ table: string; payload: unknown }> = [];
  const insert = vi.fn((payload: unknown) => {
    insertCalls.push({ table: 'audit_logs', payload });
    return Promise.resolve({
      error: opts.auditError ? { message: opts.auditError } : null,
    });
  });

  const from = vi.fn((table: string) => {
    if (table === 'knowledge_documents') return { select, delete: deleteFn };
    if (table === 'audit_logs') return { insert };
    throw new Error(`unmocked table ${table}`);
  });

  return { client: { from } as unknown, fromMock: from, eqDelete, insertCalls };
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
    expect(sb.eqDelete).toHaveBeenCalledWith('id', '11111111-1111-1111-1111-111111111111');
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

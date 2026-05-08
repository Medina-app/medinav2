import { describe, it, expect, vi } from 'vitest';
import {
  uploadKbDocument,
  downloadKbDocument,
  deleteKbDocument,
  kbDocumentPath,
  KB_UPLOADS_BUCKET,
} from '../src/kb-storage';

function mockStorageClient(behavior: {
  uploadError?: { message: string };
  downloadData?: ArrayBuffer | null;
  downloadError?: { message: string };
  removeError?: { message: string };
}) {
  const upload = vi.fn().mockResolvedValue({
    error: behavior.uploadError ?? null,
  });
  const download = vi.fn().mockResolvedValue({
    data: behavior.downloadData != null ? new Blob([behavior.downloadData]) : null,
    error: behavior.downloadError ?? null,
  });
  const remove = vi.fn().mockResolvedValue({
    error: behavior.removeError ?? null,
  });
  const from = vi.fn().mockReturnValue({ upload, download, remove });
  return {
    storage: { from },
    sb: { storage: { from } } as never,
    fromMock: from,
    upload,
    download,
    remove,
  };
}

describe('kb-storage helpers', () => {
  it('kbDocumentPath constrói canonical path {clinicId}/{docId}.{ext}', () => {
    expect(kbDocumentPath('clinic-a', 'doc-1', 'md')).toBe('clinic-a/doc-1.md');
  });

  it('KB_UPLOADS_BUCKET exporta nome do bucket', () => {
    expect(KB_UPLOADS_BUCKET).toBe('kb-uploads');
  });

  it('uploadKbDocument chama storage.upload com path canonical + contentType + upsert=false', async () => {
    const m = mockStorageClient({});
    const body = Buffer.from('# hello');

    const result = await uploadKbDocument({
      sb: m.sb,
      clinicId: 'clinic-A',
      documentId: 'doc-1',
      ext: 'md',
      body,
      mimeType: 'text/markdown',
    });

    expect(result.path).toBe('clinic-A/doc-1.md');
    expect(m.fromMock).toHaveBeenCalledWith('kb-uploads');
    expect(m.upload).toHaveBeenCalledWith('clinic-A/doc-1.md', body, {
      contentType: 'text/markdown',
      upsert: false,
    });
  });

  it('uploadKbDocument lança quando storage retorna erro (e.g., RLS denied)', async () => {
    const m = mockStorageClient({
      uploadError: { message: 'new row violates row-level security' },
    });
    await expect(
      uploadKbDocument({
        sb: m.sb,
        clinicId: 'clinic-A',
        documentId: 'doc-1',
        ext: 'md',
        body: Buffer.from('x'),
        mimeType: 'text/markdown',
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('downloadKbDocument retorna Buffer convertido de Blob', async () => {
    const text = new TextEncoder().encode('hello world');
    const m = mockStorageClient({ downloadData: text.buffer });

    const buf = await downloadKbDocument({ sb: m.sb, path: 'clinic-A/doc-1.md' });

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('utf-8')).toBe('hello world');
  });

  it('downloadKbDocument lança quando storage retorna erro', async () => {
    const m = mockStorageClient({ downloadError: { message: 'object not found' } });
    await expect(
      downloadKbDocument({ sb: m.sb, path: 'clinic-A/missing.md' }),
    ).rejects.toThrow(/object not found/);
  });

  it('downloadKbDocument lança quando data é null sem erro explícito', async () => {
    const m = mockStorageClient({ downloadData: null });
    await expect(
      downloadKbDocument({ sb: m.sb, path: 'clinic-A/empty.md' }),
    ).rejects.toThrow(/no data/);
  });

  it('deleteKbDocument chama storage.remove([path])', async () => {
    const m = mockStorageClient({});
    await deleteKbDocument({ sb: m.sb, path: 'clinic-A/doc-1.md' });

    expect(m.remove).toHaveBeenCalledWith(['clinic-A/doc-1.md']);
  });

  it('deleteKbDocument lança quando storage retorna erro', async () => {
    const m = mockStorageClient({ removeError: { message: 'permission denied' } });
    await expect(
      deleteKbDocument({ sb: m.sb, path: 'clinic-A/doc-1.md' }),
    ).rejects.toThrow(/permission denied/);
  });
});

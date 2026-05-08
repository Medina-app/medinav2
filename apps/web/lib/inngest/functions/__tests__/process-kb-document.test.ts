import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processKbDocumentHandler,
  type ProcessKbDocumentDeps,
  type ProcessKbDocumentEvent,
  type StepLike,
} from '../process-kb-document';

const fakeStep: StepLike = {
  run: <T>(_name: string, fn: () => Promise<T>) => fn(),
};

function makeDeps(overrides: Partial<ProcessKbDocumentDeps> = {}): ProcessKbDocumentDeps {
  return {
    loadDocument: vi.fn().mockResolvedValue({
      clinic_id: 'clinic-A',
      status: 'pending',
      approval_status: 'approved',
    }),
    downloadDocument: vi.fn().mockResolvedValue(Buffer.from('# Title\n\nFirst paragraph.\n\nSecond paragraph.')),
    parseDocument: vi.fn().mockResolvedValue({
      text: '# Title\n\nFirst paragraph.\n\nSecond paragraph.',
      warnings: [],
    }),
    generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
    insertChunksAndMarkIndexed: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const baseEvent: ProcessKbDocumentEvent = {
  data: { clinicId: 'clinic-A', documentId: 'doc-1', ext: 'md' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('processKbDocumentHandler', () => {
  it('happy path: download → parse → chunk → embed → insert + mark indexed', async () => {
    const deps = makeDeps();
    const result = await processKbDocumentHandler(baseEvent, fakeStep, deps);

    expect(deps.downloadDocument).toHaveBeenCalledWith('clinic-A/doc-1.md');
    expect(deps.parseDocument).toHaveBeenCalled();
    expect(deps.generateEmbedding).toHaveBeenCalledTimes(3); // # Title, First, Second (3 paragraphs)
    expect(deps.insertChunksAndMarkIndexed).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc-1',
        clinicId: 'clinic-A',
        chunks: expect.arrayContaining([expect.objectContaining({ index: 0 })]),
      }),
    );
    expect(result.chunksCreated).toBe(3);
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it('cross-tenant guard: doc clinic A com event.clinicId B → throw', async () => {
    const deps = makeDeps({
      loadDocument: vi.fn().mockResolvedValue({
        clinic_id: 'clinic-OTHER',
        status: 'pending',
        approval_status: 'approved',
      }),
    });
    await expect(processKbDocumentHandler(baseEvent, fakeStep, deps)).rejects.toThrow(
      /cross-tenant violation/i,
    );
    expect(deps.downloadDocument).not.toHaveBeenCalled();
  });

  it('approval guard: doc com approval_status=pending_approval → throw', async () => {
    const deps = makeDeps({
      loadDocument: vi.fn().mockResolvedValue({
        clinic_id: 'clinic-A',
        status: 'pending',
        approval_status: 'pending_approval',
      }),
    });
    await expect(processKbDocumentHandler(baseEvent, fakeStep, deps)).rejects.toThrow(
      /not approved/i,
    );
  });

  it('approval guard: doc com approval_status=rejected → throw', async () => {
    const deps = makeDeps({
      loadDocument: vi.fn().mockResolvedValue({
        clinic_id: 'clinic-A',
        status: 'pending',
        approval_status: 'rejected',
      }),
    });
    await expect(processKbDocumentHandler(baseEvent, fakeStep, deps)).rejects.toThrow(
      /not approved/i,
    );
  });

  it('idempotência: doc já indexed → no-op (skip download/parse/embed)', async () => {
    const deps = makeDeps({
      loadDocument: vi.fn().mockResolvedValue({
        clinic_id: 'clinic-A',
        status: 'indexed',
        approval_status: 'approved',
      }),
    });
    const result = await processKbDocumentHandler(baseEvent, fakeStep, deps);

    expect(result.chunksCreated).toBe(0);
    expect(result.warnings).toContain('already indexed');
    expect(deps.downloadDocument).not.toHaveBeenCalled();
    expect(deps.generateEmbedding).not.toHaveBeenCalled();
  });

  it('failure mid-loop: embed throw → markFailed + re-throw', async () => {
    const deps = makeDeps({
      generateEmbedding: vi.fn()
        .mockResolvedValueOnce(new Array(1536).fill(0.1))
        .mockRejectedValueOnce(new Error('OpenAI rate limit')),
    });
    await expect(processKbDocumentHandler(baseEvent, fakeStep, deps)).rejects.toThrow(
      'OpenAI rate limit',
    );
    expect(deps.markFailed).toHaveBeenCalledWith('doc-1', expect.stringContaining('OpenAI rate limit'));
    expect(deps.insertChunksAndMarkIndexed).not.toHaveBeenCalled();
  });

  it('empty file: 0 chunks → status=indexed, chunk_count=0 (sem error)', async () => {
    const deps = makeDeps({
      parseDocument: vi.fn().mockResolvedValue({ text: '', warnings: [] }),
    });
    const result = await processKbDocumentHandler(baseEvent, fakeStep, deps);

    expect(result.chunksCreated).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(deps.generateEmbedding).not.toHaveBeenCalled();
    expect(deps.insertChunksAndMarkIndexed).toHaveBeenCalledWith(
      expect.objectContaining({ chunks: [], totalTokens: 0 }),
    );
  });

  it('document not found → throw (não markFailed pq sem doc nada a marcar)', async () => {
    const deps = makeDeps({
      loadDocument: vi.fn().mockResolvedValue(null),
    });
    await expect(processKbDocumentHandler(baseEvent, fakeStep, deps)).rejects.toThrow(
      /not found/i,
    );
  });

  it('parser warnings propagam pra result (e.g., DOCX images ignored)', async () => {
    const deps = makeDeps({
      parseDocument: vi.fn().mockResolvedValue({
        text: 'Conteúdo extraído',
        warnings: ['warning: Image ignored'],
      }),
    });
    const result = await processKbDocumentHandler(baseEvent, fakeStep, deps);
    expect(result.warnings).toContain('warning: Image ignored');
  });

  it('downloadDocument failure → markFailed + re-throw', async () => {
    const deps = makeDeps({
      downloadDocument: vi.fn().mockRejectedValue(new Error('object not found')),
    });
    await expect(processKbDocumentHandler(baseEvent, fakeStep, deps)).rejects.toThrow(
      'object not found',
    );
    expect(deps.markFailed).toHaveBeenCalledWith('doc-1', expect.stringContaining('object not found'));
  });
});

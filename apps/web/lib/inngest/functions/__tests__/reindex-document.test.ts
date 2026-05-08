import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  reindexDocumentHandler,
  type ReindexDocumentDeps,
  type ReindexDocumentEvent,
  type StepLike,
} from '../reindex-document';

const fakeStep: StepLike = {
  run: <T>(_name: string, fn: () => Promise<T>) => fn(),
};

function makeDeps(overrides: Partial<ReindexDocumentDeps> = {}): ReindexDocumentDeps {
  return {
    // Issue #18: cross-tenant guard — produção verifica ownership antes de
    // chunkar/embedar. Default mock retorna mesma clinic do baseEvent.
    loadDocumentClinicId: vi.fn().mockResolvedValue('clinic-A'),
    loadChunks: vi.fn().mockResolvedValue([
      { id: 'c1', content: 'first chunk content' },
      { id: 'c2', content: 'second chunk content' },
    ]),
    generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
    updateChunkEmbedding: vi.fn().mockResolvedValue(undefined),
    markIndexed: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const baseEvent: ReindexDocumentEvent = {
  data: { clinicId: 'clinic-A', documentId: 'doc-1' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reindexDocumentHandler', () => {
  it('regenerates an embedding for every chunk of the document', async () => {
    const deps = makeDeps();
    const result = await reindexDocumentHandler(baseEvent, fakeStep, deps);

    expect(deps.loadChunks).toHaveBeenCalledWith('doc-1');
    expect(deps.generateEmbedding).toHaveBeenCalledTimes(2);
    expect(deps.generateEmbedding).toHaveBeenNthCalledWith(1, 'first chunk content');
    expect(deps.generateEmbedding).toHaveBeenNthCalledWith(2, 'second chunk content');
    expect(result).toEqual({ chunksReindexed: 2 });
  });

  it('persists each new embedding via updateChunkEmbedding(chunkId, embedding)', async () => {
    const deps = makeDeps();
    await reindexDocumentHandler(baseEvent, fakeStep, deps);

    expect(deps.updateChunkEmbedding).toHaveBeenNthCalledWith(1, 'c1', expect.any(Array));
    expect(deps.updateChunkEmbedding).toHaveBeenNthCalledWith(2, 'c2', expect.any(Array));
  });

  it('marks the document as indexed at the end of the run', async () => {
    const deps = makeDeps();
    await reindexDocumentHandler(baseEvent, fakeStep, deps);

    expect(deps.markIndexed).toHaveBeenCalledWith('doc-1');
  });

  it('is a no-op (chunksReindexed=0, no markIndexed) when the document has no chunks', async () => {
    const deps = makeDeps({ loadChunks: vi.fn().mockResolvedValue([]) });
    const result = await reindexDocumentHandler(baseEvent, fakeStep, deps);

    expect(result).toEqual({ chunksReindexed: 0 });
    expect(deps.generateEmbedding).not.toHaveBeenCalled();
    expect(deps.updateChunkEmbedding).not.toHaveBeenCalled();
    // markIndexed still flips status to indexed (an empty document is still "indexed").
    expect(deps.markIndexed).toHaveBeenCalledWith('doc-1');
  });

  it('propagates embedding errors so Inngest retries (no silent failure)', async () => {
    const deps = makeDeps({
      generateEmbedding: vi.fn().mockRejectedValueOnce(new Error('OpenAI rate limit')),
    });
    await expect(reindexDocumentHandler(baseEvent, fakeStep, deps)).rejects.toThrow(
      'OpenAI rate limit',
    );
    // updateChunkEmbedding never called for the failed chunk
    expect(deps.updateChunkEmbedding).not.toHaveBeenCalled();
    // markIndexed never reached
    expect(deps.markIndexed).not.toHaveBeenCalled();
  });

  // Issue #18: cross-tenant defense in depth. Sem caller atualmente, mas
  // AI-3.5 (upload UI) vai disparar — precisa validar event.clinicId vs
  // documents.clinic_id antes do loop de embeddings.

  it('rejects with cross-tenant violation when document belongs to other clinic (#18)', async () => {
    const deps = makeDeps({
      loadDocumentClinicId: vi.fn().mockResolvedValue('clinic-OTHER'),
    });
    await expect(reindexDocumentHandler(baseEvent, fakeStep, deps)).rejects.toThrow(
      /cross.tenant/i,
    );
    // Verify nem chunks nem embeddings foram tocados após guard fail.
    expect(deps.loadChunks).not.toHaveBeenCalled();
    expect(deps.generateEmbedding).not.toHaveBeenCalled();
    expect(deps.markIndexed).not.toHaveBeenCalled();
  });

  it('rejects when document does not exist (loadDocumentClinicId retorna null) (#18)', async () => {
    const deps = makeDeps({
      loadDocumentClinicId: vi.fn().mockResolvedValue(null),
    });
    await expect(reindexDocumentHandler(baseEvent, fakeStep, deps)).rejects.toThrow(
      /not found/i,
    );
    expect(deps.loadChunks).not.toHaveBeenCalled();
  });

  it('verifica clinic_id ANTES de loadChunks (ordem importa pra defense in depth) (#18)', async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      loadDocumentClinicId: vi.fn().mockImplementation(async () => {
        callOrder.push('loadDocumentClinicId');
        return 'clinic-A';
      }),
      loadChunks: vi.fn().mockImplementation(async () => {
        callOrder.push('loadChunks');
        return [];
      }),
    });
    await reindexDocumentHandler(baseEvent, fakeStep, deps);
    expect(callOrder).toEqual(['loadDocumentClinicId', 'loadChunks']);
  });
});

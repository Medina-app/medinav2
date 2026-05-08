import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { generateEmbedding } from '@medina/ai';
import { inngest } from '@/lib/inngest/client';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReindexDocumentEvent = {
  data: { clinicId: string; documentId: string };
};

export type ReindexDocumentDeps = {
  /** Issue #18: cross-tenant defense in depth. Lookup do clinic_id do doc
   *  ANTES de embedar/atualizar chunks. Caller compara com event.data.clinicId
   *  e lança se diferente. Returns null se doc nao existe. */
  loadDocumentClinicId: (documentId: string) => Promise<string | null>;
  loadChunks: (documentId: string) => Promise<Array<{ id: string; content: string }>>;
  generateEmbedding: (text: string) => Promise<number[]>;
  updateChunkEmbedding: (chunkId: string, embedding: number[]) => Promise<void>;
  markIndexed: (documentId: string) => Promise<void>;
};

export type StepLike = {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
};

export type ReindexDocumentResult = { chunksReindexed: number };

// ─── Handler (testable) ─────────────────────────────────────────────────────

/**
 * Re-runs the embedding generation for every chunk of an existing document.
 * Use cases (AI-3.5+): admin-triggered reindex after model upgrade, or after
 * an in-place edit of a document's chunks. Does NOT re-chunk content — assumes
 * chunks already exist and only their embeddings need refreshing.
 *
 * No caller is wired in AI-3 — the function is registered but only fires when
 * something dispatches `kb/document.reindex`. AI-3.5 (upload UI) will dispatch.
 */
export async function reindexDocumentHandler(
  event: ReindexDocumentEvent,
  step: StepLike,
  deps: ReindexDocumentDeps,
): Promise<ReindexDocumentResult> {
  const { clinicId, documentId } = event.data;

  // Issue #18: cross-tenant guard ANTES de qualquer trabalho. Sem caller
  // atualmente em prod (AI-3.5 vai disparar), mas defense in depth: nao
  // assume que o caller validou ownership.
  const docClinicId = await step.run('verify-clinic-ownership', () =>
    deps.loadDocumentClinicId(documentId),
  );
  if (docClinicId == null) {
    throw new Error(`reindex-document: document ${documentId} not found`);
  }
  if (docClinicId !== clinicId) {
    throw new Error(
      `reindex-document: cross-tenant violation: document ${documentId} belongs to ${docClinicId}, not ${clinicId}`,
    );
  }

  const chunks = await step.run('load-chunks', () => deps.loadChunks(documentId));

  for (const chunk of chunks) {
    await step.run(`embed-${chunk.id}`, async () => {
      const embedding = await deps.generateEmbedding(chunk.content);
      await deps.updateChunkEmbedding(chunk.id, embedding);
    });
  }

  await step.run('mark-indexed', () => deps.markIndexed(documentId));

  return { chunksReindexed: chunks.length };
}

// ─── Production wiring ──────────────────────────────────────────────────────

function makeAdminSupabase(): SupabaseClient {
  return createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export function makeReindexDocumentDeps(sb?: SupabaseClient): ReindexDocumentDeps {
  const client = sb ?? makeAdminSupabase();
  return {
    async loadDocumentClinicId(documentId) {
      const { data, error } = await client
        .from('knowledge_documents')
        .select('clinic_id')
        .eq('id', documentId)
        .maybeSingle();
      if (error) {
        throw new Error(`reindex-document: loadDocumentClinicId failed: ${error.message}`);
      }
      return (data as { clinic_id?: string } | null)?.clinic_id ?? null;
    },
    async loadChunks(documentId) {
      const { data, error } = await client
        .from('knowledge_chunks')
        .select('id, content')
        .eq('document_id', documentId)
        .order('chunk_index', { ascending: true });
      if (error) throw new Error(`reindex-document: loadChunks failed: ${error.message}`);
      return (data ?? []) as Array<{ id: string; content: string }>;
    },
    generateEmbedding,
    async updateChunkEmbedding(chunkId, embedding) {
      const { error } = await client
        .from('knowledge_chunks')
        .update({ embedding })
        .eq('id', chunkId);
      if (error) throw new Error(`reindex-document: updateChunkEmbedding failed: ${error.message}`);
    },
    async markIndexed(documentId) {
      const { error } = await client
        .from('knowledge_documents')
        .update({ status: 'indexed', indexed_at: new Date().toISOString() })
        .eq('id', documentId);
      if (error) throw new Error(`reindex-document: markIndexed failed: ${error.message}`);
    },
  };
}

// ─── Inngest registration ───────────────────────────────────────────────────

export const reindexDocument = inngest.createFunction(
  {
    id: 'reindex-document',
    retries: 2,
    triggers: [{ event: 'kb/document.reindex' }],
  },
  async ({ event, step }) =>
    reindexDocumentHandler(
      event as unknown as ReindexDocumentEvent,
      step as unknown as StepLike,
      makeReindexDocumentDeps(),
    ),
);

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  generateEmbedding,
  parseDocument,
  chunkMarkdown,
  approxTokens,
} from '@medina/ai';
import { downloadKbDocument, kbDocumentPath } from '@medina/chat';
import { inngest } from '@/lib/inngest/client';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProcessKbDocumentEvent = {
  data: {
    clinicId: string;
    documentId: string;
    /** Extensão do arquivo (md/txt/pdf/docx) — used to detect parser. */
    ext: string;
    /** Mime type opcional pra detecção fina. */
    mimeType?: string;
  };
};

export type StepLike = {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
};

export type ProcessKbDocumentDeps = {
  /** Lookup pra cross-tenant guard + idempotência (status check). */
  loadDocument: (
    documentId: string,
  ) => Promise<{ clinic_id: string; status: string; approval_status: string } | null>;
  /** Download bytes do storage (kb-uploads bucket). */
  downloadDocument: (path: string) => Promise<Buffer>;
  /** Parser: bytes → text. Worker passa hint = ext (md/txt/pdf/docx). */
  parseDocument: (body: Buffer, hint: string) => Promise<{ text: string; warnings: string[] }>;
  /** Embed cada chunk via OpenAI. */
  generateEmbedding: (text: string) => Promise<number[]>;
  /** Insert chunks em batch + UPDATE status='indexed'. */
  insertChunksAndMarkIndexed: (args: {
    documentId: string;
    clinicId: string;
    chunks: Array<{ index: number; content: string; tokens: number; embedding: number[] }>;
    totalTokens: number;
  }) => Promise<void>;
  /** Marca status='failed' + error_message em catch (best-effort). */
  markFailed: (documentId: string, errorMessage: string) => Promise<void>;
};

export type ProcessKbDocumentResult = {
  chunksCreated: number;
  totalTokens: number;
  warnings: string[];
};

// ─── Handler (testable) ─────────────────────────────────────────────────────

/**
 * AI-3.5b worker — processa knowledge_document do upload até indexed.
 *
 * Flow:
 *   1. verify-clinic-ownership: doc.clinic_id == event.clinicId (defesa)
 *   2. idempotency: skip se já status='indexed' (re-dispatch acidental)
 *   3. download-from-storage: kb-uploads/{clinicId}/{documentId}.{ext}
 *   4. parse-document: bytes → text (MD/TXT/PDF/DOCX)
 *   5. chunk + embed: chunkMarkdown + generateEmbedding por chunk
 *   6. insert-chunks-and-mark: INSERT + UPDATE status='indexed' atomically
 *
 * Failure: try/catch ao redor das etapas 3-6 → markFailed com error_message
 * estruturado. Idempotência permite re-dispatch após fix manual.
 *
 * Approval: worker NUNCA dispara automaticamente no upload — só após admin
 * aprovar via approveKbDocumentAction. doc com approval_status != 'approved'
 * resulta em RAISE (defesa contra event spoofing).
 */
export async function processKbDocumentHandler(
  event: ProcessKbDocumentEvent,
  step: StepLike,
  deps: ProcessKbDocumentDeps,
): Promise<ProcessKbDocumentResult> {
  const { clinicId, documentId, ext, mimeType } = event.data;

  // 1. Cross-tenant guard + status check.
  const doc = await step.run('verify-doc', () => deps.loadDocument(documentId));
  if (!doc) {
    throw new Error(`process-kb-document: document ${documentId} not found`);
  }
  if (doc.clinic_id !== clinicId) {
    throw new Error(
      `process-kb-document: cross-tenant violation: document ${documentId} belongs to ${doc.clinic_id}, not ${clinicId}`,
    );
  }
  if (doc.approval_status !== 'approved') {
    throw new Error(
      `process-kb-document: document ${documentId} not approved (approval_status=${doc.approval_status}). Worker só processa docs aprovados.`,
    );
  }
  if (doc.status === 'indexed') {
    // Idempotência — re-dispatch após indexed é no-op.
    return { chunksCreated: 0, totalTokens: 0, warnings: ['already indexed'] };
  }

  try {
    const path = kbDocumentPath(clinicId, documentId, ext);
    const body = await step.run('download', () => deps.downloadDocument(path));

    const hint = mimeType ?? ext;
    const parsed = await step.run('parse', () => deps.parseDocument(body, hint));

    const chunkTexts = chunkMarkdown(parsed.text);
    if (chunkTexts.length === 0) {
      // Doc vazio — marca indexed com 0 chunks (conteúdo vazio é valid edge case).
      await deps.insertChunksAndMarkIndexed({
        documentId,
        clinicId,
        chunks: [],
        totalTokens: 0,
      });
      return { chunksCreated: 0, totalTokens: 0, warnings: parsed.warnings };
    }

    const chunks: Array<{ index: number; content: string; tokens: number; embedding: number[] }> =
      [];
    let totalTokens = 0;
    for (let i = 0; i < chunkTexts.length; i++) {
      const text = chunkTexts[i] ?? '';
      const tokens = approxTokens(text);
      totalTokens += tokens;
      const embedding = await step.run(`embed-${i}`, () => deps.generateEmbedding(text));
      chunks.push({ index: i, content: text, tokens, embedding });
    }

    await step.run('insert-chunks', () =>
      deps.insertChunksAndMarkIndexed({ documentId, clinicId, chunks, totalTokens }),
    );

    return {
      chunksCreated: chunks.length,
      totalTokens,
      warnings: parsed.warnings,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort: marca status='failed' + error_message. Re-throw pra
    // Inngest retries (retries=2 default). Após esgotar retries, doc fica
    // 'failed' e admin pode usar reindex button.
    try {
      await deps.markFailed(documentId, message);
    } catch {
      /* swallow secondary error */
    }
    throw err;
  }
}

// ─── Production wiring ──────────────────────────────────────────────────────

function makeAdminSupabase(): SupabaseClient {
  return createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export function makeProcessKbDocumentDeps(sb?: SupabaseClient): ProcessKbDocumentDeps {
  const client = sb ?? makeAdminSupabase();
  return {
    async loadDocument(documentId) {
      const { data, error } = await client
        .from('knowledge_documents')
        .select('clinic_id, status, approval_status')
        .eq('id', documentId)
        .maybeSingle();
      if (error) {
        throw new Error(`process-kb-document: loadDocument: ${error.message}`);
      }
      return (data as { clinic_id: string; status: string; approval_status: string } | null) ?? null;
    },
    async downloadDocument(path) {
      return downloadKbDocument({ sb: client, path });
    },
    async parseDocument(body, hint) {
      return parseDocument({ body, hint });
    },
    generateEmbedding,
    async insertChunksAndMarkIndexed({ documentId, clinicId, chunks, totalTokens }) {
      if (chunks.length > 0) {
        const { error: insErr } = await client.from('knowledge_chunks').insert(
          chunks.map((c) => ({
            clinic_id: clinicId,
            document_id: documentId,
            chunk_index: c.index,
            content: c.content,
            token_count: c.tokens,
            embedding: c.embedding,
            metadata: {},
          })),
        );
        if (insErr) {
          throw new Error(`process-kb-document: insertChunks: ${insErr.message}`);
        }
      }
      const { error: updErr } = await client
        .from('knowledge_documents')
        .update({
          status: 'indexed',
          chunk_count: chunks.length,
          total_tokens: totalTokens,
          indexed_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('id', documentId);
      if (updErr) {
        throw new Error(`process-kb-document: markIndexed: ${updErr.message}`);
      }
    },
    async markFailed(documentId, errorMessage) {
      // Truncate error_message pra evitar overflow (text column é unbounded
      // mas mensagens longas demais polui UI).
      const truncated = errorMessage.slice(0, 500);
      await client
        .from('knowledge_documents')
        .update({ status: 'failed', error_message: truncated })
        .eq('id', documentId);
    },
  };
}

// ─── Inngest registration ───────────────────────────────────────────────────

export const processKbDocument = inngest.createFunction(
  {
    id: 'process-kb-document',
    retries: 2,
    triggers: [{ event: 'kb/document.process' }],
  },
  async ({ event, step }) =>
    processKbDocumentHandler(
      event as unknown as ProcessKbDocumentEvent,
      step as unknown as StepLike,
      makeProcessKbDocumentDeps(),
    ),
);

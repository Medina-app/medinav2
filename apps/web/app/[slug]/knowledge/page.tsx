import { getTenantContext, getSupabaseServerClient } from '@medina/auth';
import { KbDocumentList, type KbDocument } from './_components/kb-document-list';
import KbEmptyState from './_components/kb-empty-state';
import type { DocumentStatus } from './_components/kb-status-badge';

interface RawDocRow {
  id: string;
  title: string;
  source_type: string;
  status: string;
  error_message: string | null;
  chunk_count: number;
  total_tokens: number;
  file_size_bytes: number | null;
  created_at: string;
  archived_at: string | null;
}

function mapDocument(row: RawDocRow): KbDocument {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.source_type as KbDocument['sourceType'],
    status: row.status as DocumentStatus,
    errorMessage: row.error_message,
    chunkCount: row.chunk_count,
    totalTokens: row.total_tokens,
    fileSizeBytes: row.file_size_bytes,
    createdAt: new Date(row.created_at),
  };
}

export default async function KnowledgePage() {
  const [ctx, sb] = await Promise.all([getTenantContext(), getSupabaseServerClient()]);

  // RLS policy: members SELECT + archived_at IS NULL (definido em 0009).
  // Filtro explícito redundante mas defensivo — se policy mudar, query mantém intent.
  const { data, error } = await sb
    .from('knowledge_documents')
    .select(
      'id, title, source_type, status, error_message, chunk_count, total_tokens, file_size_bytes, created_at, archived_at',
    )
    .eq('clinic_id', ctx.clinicId)
    .is('archived_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <h1 className="text-[20px] font-semibold tracking-tight text-[var(--luma-text-primary)] mb-2">
          Base de conhecimento
        </h1>
        <p className="text-[14px] text-[var(--luma-danger)]">Falha ao carregar: {error.message}</p>
      </div>
    );
  }

  const documents = ((data ?? []) as RawDocRow[]).map(mapDocument);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold tracking-tight text-[var(--luma-text-primary)]">
          Base de conhecimento
        </h1>
        <p className="text-[13px] text-[var(--luma-text-tertiary)] mt-1">
          Documentos disponíveis pra IA usar nas respostas aos pacientes.{' '}
          {documents.length > 0 && (
            <span>
              {documents.length} {documents.length === 1 ? 'documento' : 'documentos'} indexados.
            </span>
          )}
        </p>
      </header>

      {documents.length === 0 ? (
        <KbEmptyState />
      ) : (
        <KbDocumentList documents={documents} />
      )}
    </div>
  );
}

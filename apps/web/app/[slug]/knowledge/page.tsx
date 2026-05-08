import Link from 'next/link';
import { getTenantContext, getSupabaseServerClient } from '@medina/auth';
import { KbDocumentList, type KbDocument } from './_components/kb-document-list';
import KbEmptyState from './_components/kb-empty-state';
import { KbUploadDialog } from './_components/kb-upload-dialog';
import type { DocumentStatus, ApprovalStatus } from './_components/kb-status-badge';

interface RawDocRow {
  id: string;
  title: string;
  source_type: string;
  status: string;
  approval_status: string;
  error_message: string | null;
  rejection_reason: string | null;
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
    approvalStatus: row.approval_status as ApprovalStatus,
    errorMessage: row.error_message,
    rejectionReason: row.rejection_reason,
    chunkCount: row.chunk_count,
    totalTokens: row.total_tokens,
    fileSizeBytes: row.file_size_bytes,
    createdAt: new Date(row.created_at),
  };
}

type TabKey = 'all' | 'pending' | 'approved' | 'rejected';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'pending', label: 'Pendentes' },
  { key: 'approved', label: 'Aprovados' },
  { key: 'rejected', label: 'Rejeitados' },
];

function parseTab(value: string | string[] | undefined): TabKey {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === 'pending' || v === 'approved' || v === 'rejected') return v;
  return 'all';
}

function filterByTab(docs: KbDocument[], tab: TabKey): KbDocument[] {
  if (tab === 'pending') return docs.filter((d) => d.approvalStatus === 'pending_approval');
  if (tab === 'approved') return docs.filter((d) => d.approvalStatus === 'approved');
  if (tab === 'rejected') return docs.filter((d) => d.approvalStatus === 'rejected');
  return docs;
}

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}

export default async function KnowledgePage({ params, searchParams }: PageProps) {
  const [{ slug }, sp, ctx, sb] = await Promise.all([
    params,
    searchParams,
    getTenantContext(),
    getSupabaseServerClient(),
  ]);

  const activeTab = parseTab(sp.tab);
  const canModerate = ctx.role === 'admin' || ctx.role === 'owner';

  // RLS policy: members SELECT + archived_at IS NULL (definido em 0009).
  // Filtro explícito redundante mas defensivo — se policy mudar, query mantém intent.
  const { data, error } = await sb
    .from('knowledge_documents')
    .select(
      'id, title, source_type, status, approval_status, error_message, rejection_reason, chunk_count, total_tokens, file_size_bytes, created_at, archived_at',
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

  const allDocs = ((data ?? []) as RawDocRow[]).map(mapDocument);
  const counts = {
    all: allDocs.length,
    pending: allDocs.filter((d) => d.approvalStatus === 'pending_approval').length,
    approved: allDocs.filter((d) => d.approvalStatus === 'approved').length,
    rejected: allDocs.filter((d) => d.approvalStatus === 'rejected').length,
  };
  const visible = filterByTab(allDocs, activeTab);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-[var(--luma-text-primary)]">
            Base de conhecimento
          </h1>
          <p className="text-[13px] text-[var(--luma-text-tertiary)] mt-1">
            Documentos disponíveis pra IA usar nas respostas aos pacientes.{' '}
            {counts.approved > 0 && (
              <span>
                {counts.approved} {counts.approved === 1 ? 'aprovado' : 'aprovados'} ·{' '}
                {counts.pending} {counts.pending === 1 ? 'pendente' : 'pendentes'}.
              </span>
            )}
          </p>
        </div>
        {canModerate && <KbUploadDialog />}
      </header>

      <nav className="flex items-center gap-1 mb-5 border-b border-[var(--luma-border)]">
        {TABS.map((t) => {
          const isActive = t.key === activeTab;
          const href =
            t.key === 'all' ? `/${slug}/knowledge` : `/${slug}/knowledge?tab=${t.key}`;
          return (
            <Link
              key={t.key}
              href={href}
              className={[
                'inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors -mb-px',
                isActive
                  ? 'text-[var(--luma-text-primary)] border-b-2 border-[var(--luma-accent)]'
                  : 'text-[var(--luma-text-tertiary)] hover:text-[var(--luma-text-secondary)] border-b-2 border-transparent',
              ].join(' ')}
            >
              {t.label}
              <span className="text-[11px] text-[var(--luma-text-tertiary)] tabular-nums">
                {counts[t.key]}
              </span>
            </Link>
          );
        })}
      </nav>

      {visible.length === 0 ? (
        activeTab === 'all' ? (
          <KbEmptyState />
        ) : (
          <p className="text-[13px] text-[var(--luma-text-tertiary)] py-12 text-center">
            Nenhum documento nesta categoria.
          </p>
        )
      ) : (
        <KbDocumentList documents={visible} canModerate={canModerate} />
      )}
    </div>
  );
}

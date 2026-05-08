import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  getKbStatusBadge,
  type DocumentStatus,
  type ApprovalStatus,
} from './kb-status-badge';
import { DeleteDocDialog } from './delete-doc-dialog';
import { ApproveButton } from './approve-button';
import { RejectDialog } from './reject-dialog';
import { ReindexButton } from './reindex-button';

export interface KbDocument {
  id: string;
  title: string;
  sourceType: 'pdf' | 'docx' | 'txt' | 'md' | 'url' | 'manual';
  status: DocumentStatus;
  approvalStatus: ApprovalStatus;
  errorMessage: string | null;
  rejectionReason: string | null;
  chunkCount: number;
  totalTokens: number;
  fileSizeBytes: number | null;
  createdAt: Date;
}

interface KbDocumentListProps {
  documents: readonly KbDocument[];
  /** Quando true (admin/owner), renderiza botões de aprovação/rejeição. */
  canModerate: boolean;
}

const SOURCE_LABEL: Record<KbDocument['sourceType'], string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  txt: 'TXT',
  md: 'Markdown',
  url: 'URL',
  manual: 'Manual',
};

function formatDate(date: Date): string {
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * AI-3.5a/b: tabela de documents da KB.
 *
 * AI-3.5b: badge agora considera approval_status (precedência sobre status).
 * Botões condicionais por approval_status:
 *   - pending_approval + canModerate → Aprovar / Rejeitar
 *   - approved + canModerate → Re-indexar (apenas approved pode re-disparar)
 *   - rejected → sem botões de ação (apenas Excluir)
 *   - todos → Excluir (admin/owner)
 */
export function KbDocumentList({ documents, canModerate }: KbDocumentListProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-b border-[var(--luma-border)]">
          <TableHead className="text-[12px] font-medium text-[var(--luma-text-secondary)]">
            Título
          </TableHead>
          <TableHead className="text-[12px] font-medium text-[var(--luma-text-secondary)]">
            Tipo
          </TableHead>
          <TableHead className="text-[12px] font-medium text-[var(--luma-text-secondary)]">
            Status
          </TableHead>
          <TableHead className="text-[12px] font-medium text-[var(--luma-text-secondary)] text-right">
            Chunks
          </TableHead>
          <TableHead className="text-[12px] font-medium text-[var(--luma-text-secondary)] text-right">
            Tamanho
          </TableHead>
          <TableHead className="text-[12px] font-medium text-[var(--luma-text-secondary)] text-right">
            Adicionado
          </TableHead>
          <TableHead className="text-right">
            <span className="sr-only">Ações</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {documents.map((doc) => {
          // Badge title pra rejected mostra rejection_reason; pra failed,
          // errorMessage. getKbStatusBadge prioriza approval_status quando
          // != 'approved'.
          const titleHint =
            doc.approvalStatus === 'rejected' ? doc.rejectionReason : doc.errorMessage;
          const badge = getKbStatusBadge(doc.status, titleHint, doc.approvalStatus);
          return (
            <TableRow
              key={doc.id}
              className="border-b border-[var(--luma-border)]"
              data-testid="kb-doc-row"
              data-doc-id={doc.id}
            >
              <TableCell className="font-medium text-[14px] text-[var(--luma-text-primary)]">
                {doc.title}
              </TableCell>
              <TableCell className="text-[13px] text-[var(--luma-text-secondary)]">
                {SOURCE_LABEL[doc.sourceType]}
              </TableCell>
              <TableCell>
                {badge ? (
                  <span className={badge.className} title={badge.title}>
                    {badge.label}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-[13px] text-[var(--luma-text-secondary)] text-right tabular-nums">
                {doc.chunkCount}
              </TableCell>
              <TableCell className="text-[13px] text-[var(--luma-text-secondary)] text-right tabular-nums">
                {formatSize(doc.fileSizeBytes)}
              </TableCell>
              <TableCell className="text-[13px] text-[var(--luma-text-tertiary)] text-right">
                {formatDate(doc.createdAt)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1.5 flex-wrap">
                  {canModerate && doc.approvalStatus === 'pending_approval' && (
                    <>
                      <ApproveButton documentId={doc.id} />
                      <RejectDialog documentId={doc.id} documentTitle={doc.title} />
                    </>
                  )}
                  {canModerate && doc.approvalStatus === 'approved' && (
                    <ReindexButton documentId={doc.id} />
                  )}
                  <DeleteDocDialog documentId={doc.id} documentTitle={doc.title} />
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

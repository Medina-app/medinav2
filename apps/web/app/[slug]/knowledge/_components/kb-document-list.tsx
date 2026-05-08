import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getKbStatusBadge, type DocumentStatus } from './kb-status-badge';
import { DeleteDocDialog } from './delete-doc-dialog';

export interface KbDocument {
  id: string;
  title: string;
  sourceType: 'pdf' | 'docx' | 'txt' | 'md' | 'url' | 'manual';
  status: DocumentStatus;
  errorMessage: string | null;
  chunkCount: number;
  totalTokens: number;
  fileSizeBytes: number | null;
  createdAt: Date;
}

interface KbDocumentListProps {
  documents: readonly KbDocument[];
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
 * AI-3.5a: tabela de documents da KB. Renderiza title, type, status badge,
 * chunks count, size, data, e botão delete (via DeleteDocDialog client).
 *
 * Pure presentational — toda mutação via DeleteDocDialog → server action.
 */
export function KbDocumentList({ documents }: KbDocumentListProps) {
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
          const badge = getKbStatusBadge(doc.status, doc.errorMessage);
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
                <DeleteDocDialog documentId={doc.id} documentTitle={doc.title} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

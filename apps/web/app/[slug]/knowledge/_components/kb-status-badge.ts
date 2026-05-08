/**
 * AI-3.5a: helper puro pra badge visual de status de knowledge_documents.
 *
 * Mapping (matches schema enum em packages/db/src/schema/knowledge-documents.ts):
 *   pending|processing → "⏳ Processando" (luma-text-secondary)
 *   indexed            → "✓ Indexado" (luma-success)
 *   failed             → "✗ Falhou" (luma-danger; title=errorMessage)
 *   archived           → null (não exibir; UI filtra archived da lista anyway)
 *   <unknown>          → null (defensive)
 *
 * Pure function — testable without jsdom. Consumed por kb-document-list.tsx.
 */

export type DocumentStatus = 'pending' | 'processing' | 'indexed' | 'failed' | 'archived';

export interface KbStatusBadgeProps {
  label: string;
  title: string;
  className: string;
}

const BASE = 'text-[11px] font-medium bg-[var(--luma-bg-subtle)] rounded-full px-2.5 py-0.5';

export function getKbStatusBadge(
  status: DocumentStatus,
  errorMessage?: string | null,
): KbStatusBadgeProps | null {
  switch (status) {
    case 'pending':
    case 'processing':
      return {
        label: '⏳ Processando',
        title: 'Documento sendo indexado — embedding em progresso',
        className: `${BASE} text-[var(--luma-text-secondary)]`,
      };
    case 'indexed':
      return {
        label: '✓ Indexado',
        title: 'Documento disponível para busca pela IA',
        className: `${BASE} text-[var(--luma-success)]`,
      };
    case 'failed':
      return {
        label: '✗ Falhou',
        title: errorMessage
          ? `Falha na indexação: ${errorMessage}`
          : 'Falha na indexação — tente excluir e re-fazer upload',
        className: `${BASE} text-[var(--luma-danger)]`,
      };
    case 'archived':
      return null;
    default:
      return null;
  }
}

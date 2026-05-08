/**
 * AI-3.5a/b: helper puro pra badge visual de status de knowledge_documents.
 *
 * AI-3.5b: badge agora considera ambos approval_status e status. Approval
 * tem precedência: rejected/pending_approval mostram badge de approval,
 * só approved cai pro status de processamento. Permite UI distinguir
 * "aguardando admin" de "processando embedding".
 *
 * Mapping (matches schema enum em packages/db/src/schema/knowledge-documents.ts):
 *   approval_status='pending_approval' → "⏸ Aguardando aprovação" (luma-warning)
 *   approval_status='rejected'         → "⊘ Rejeitado" (luma-text-tertiary)
 *   approval_status='approved' AND:
 *     status='pending'|'processing'    → "⏳ Processando" (luma-text-secondary)
 *     status='indexed'                 → "✓ Indexado" (luma-success)
 *     status='failed'                  → "✗ Falhou" (luma-danger; title=errorMessage)
 *   archived                           → null (UI filtra archived anyway)
 *
 * Pure function — testable without jsdom. Consumed por kb-document-list.tsx.
 */

export type DocumentStatus = 'pending' | 'processing' | 'indexed' | 'failed' | 'archived';
export type ApprovalStatus = 'pending_approval' | 'approved' | 'rejected';

export interface KbStatusBadgeProps {
  label: string;
  title: string;
  className: string;
}

const BASE = 'text-[11px] font-medium bg-[var(--luma-bg-subtle)] rounded-full px-2.5 py-0.5';

export function getKbStatusBadge(
  status: DocumentStatus,
  errorMessage?: string | null,
  approvalStatus?: ApprovalStatus,
): KbStatusBadgeProps | null {
  // Approval status precede status de pipeline.
  if (approvalStatus === 'pending_approval') {
    return {
      label: '⏸ Aguardando aprovação',
      title: 'Documento aguardando admin aprovar antes de indexar',
      className: `${BASE} text-[var(--luma-warning)]`,
    };
  }
  if (approvalStatus === 'rejected') {
    return {
      label: '⊘ Rejeitado',
      title: errorMessage
        ? `Rejeitado: ${errorMessage}`
        : 'Documento rejeitado por admin — não será usado pela IA',
      className: `${BASE} text-[var(--luma-text-tertiary)]`,
    };
  }

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

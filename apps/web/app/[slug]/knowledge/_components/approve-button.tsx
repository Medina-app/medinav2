'use client';

import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { approveKbDocumentAction } from '../actions';

interface ApproveButtonProps {
  documentId: string;
}

/**
 * AI-3.5b: aprovar doc pendente. Click → action approveKbDocumentAction →
 * worker process-kb-document dispatchado via Inngest. Toast de feedback.
 */
export function ApproveButton({ documentId }: ApproveButtonProps) {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      try {
        const result = await approveKbDocumentAction({ documentId });
        if ('error' in result) {
          toast.error(`Falha ao aprovar: ${result.error}`);
          return;
        }
        toast.success('Documento aprovado. Indexação iniciada.');
      } catch {
        toast.error('Falha inesperada ao aprovar documento.');
      }
    });
  }

  return (
    <Button
      type="button"
      variant="default"
      size="sm"
      onClick={handleClick}
      disabled={isPending}
    >
      {isPending ? 'Aprovando...' : 'Aprovar'}
    </Button>
  );
}

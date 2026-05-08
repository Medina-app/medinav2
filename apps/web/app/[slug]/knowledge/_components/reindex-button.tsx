'use client';

import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { reindexKbDocumentAction } from '../actions';

interface ReindexButtonProps {
  documentId: string;
}

/**
 * AI-3.5b: re-disparar worker pra doc aprovado. Útil pra status='failed'
 * (retry após rate limit) ou quando admin precisar regenerar chunks.
 */
export function ReindexButton({ documentId }: ReindexButtonProps) {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      try {
        const result = await reindexKbDocumentAction({ documentId });
        if ('error' in result) {
          toast.error(`Falha ao re-indexar: ${result.error}`);
          return;
        }
        toast.success('Re-indexação iniciada.');
      } catch {
        toast.error('Falha inesperada ao re-indexar documento.');
      }
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={isPending}
    >
      {isPending ? 'Enviando...' : 'Re-indexar'}
    </Button>
  );
}

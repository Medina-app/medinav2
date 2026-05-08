'use client';

import { useState, useTransition } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { deleteKbDocumentAction } from '../actions';

interface DeleteDocDialogProps {
  documentId: string;
  documentTitle: string;
}

/**
 * AI-3.5a: confirm dialog pra hard delete de knowledge_document.
 *
 * "Permanente" texto explicito porque chunks são cascade-deleted via FK
 * (não há restore). Toast de sucesso/erro via sonner. Server action faz
 * revalidatePath, page re-renderiza sem o doc deletado.
 */
export function DeleteDocDialog({ documentId, documentTitle }: DeleteDocDialogProps) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    startTransition(async () => {
      const result = await deleteKbDocumentAction({ documentId });
      if ('error' in result) {
        toast.error(`Falha ao excluir: ${result.error}`);
        return;
      }
      toast.success('Documento excluído.');
      setOpen(false);
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-[var(--luma-text-tertiary)] hover:text-[var(--luma-danger)]"
        onClick={() => setOpen(true)}
      >
        Excluir
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir documento</DialogTitle>
            <DialogDescription>
              Excluir <strong className="text-[var(--luma-text-primary)]">{documentTitle}</strong>?
              Esta ação é permanente — chunks indexados serão removidos e a IA não poderá mais
              usar esse conteúdo. Não há restauração.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleConfirm}
              disabled={isPending}
            >
              {isPending ? 'Excluindo...' : 'Excluir permanentemente'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

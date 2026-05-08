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
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { rejectKbDocumentAction } from '../actions';

interface RejectDialogProps {
  documentId: string;
  documentTitle: string;
}

/**
 * AI-3.5b: rejeitar doc pendente com motivo (3-500 chars). Doc fica visível
 * na tab "Rejeitados" pra trail de audit. Não deleta.
 */
export function RejectDialog({ documentId, documentTitle }: RejectDialogProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    if (reason.trim().length < 3) {
      toast.error('Motivo precisa ter pelo menos 3 caracteres.');
      return;
    }
    startTransition(async () => {
      try {
        const result = await rejectKbDocumentAction({
          documentId,
          reason: reason.trim(),
        });
        if ('error' in result) {
          toast.error(`Falha ao rejeitar: ${result.error}`);
          return;
        }
        toast.success('Documento rejeitado.');
        setOpen(false);
        setReason('');
      } catch {
        toast.error('Falha inesperada ao rejeitar documento.');
      }
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
        Rejeitar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rejeitar documento</DialogTitle>
            <DialogDescription>
              Rejeitar{' '}
              <strong className="text-[var(--luma-text-primary)]">{documentTitle}</strong>?
              O documento ficará marcado como rejeitado e não será indexado. O motivo aparece
              no histórico de auditoria.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="reject-reason">Motivo (3-500 caracteres)</Label>
            <textarea
              id="reject-reason"
              className="w-full min-h-[80px] rounded-md border border-[var(--luma-border)] bg-[var(--luma-bg-subtle)] px-3 py-2 text-[14px] text-[var(--luma-text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--luma-accent)]"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex: Conteúdo fora de escopo da clínica"
              maxLength={500}
              disabled={isPending}
            />
            <p className="text-[11px] text-[var(--luma-text-tertiary)] tabular-nums">
              {reason.length}/500
            </p>
          </div>
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
              disabled={isPending || reason.trim().length < 3}
            >
              {isPending ? 'Rejeitando...' : 'Rejeitar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

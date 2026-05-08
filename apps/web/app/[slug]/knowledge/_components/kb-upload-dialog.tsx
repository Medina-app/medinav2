'use client';

import { useState, useTransition, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { createKbDocumentAction } from '../actions';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXTS = ['md', 'txt', 'pdf', 'docx'];
const ACCEPT_MIME =
  '.md,.txt,.pdf,.docx,text/markdown,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * AI-3.5b: upload dialog pra novo doc da KB. Após upload, doc fica
 * pending_approval; admin precisa aprovar pra worker indexar.
 */
export function KbUploadDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setTitle('');
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (!f) {
      setFile(null);
      return;
    }
    const ext = f.name.toLowerCase().split('.').pop() ?? '';
    if (!ALLOWED_EXTS.includes(ext)) {
      toast.error(`Formato não suportado. Use ${ALLOWED_EXTS.join(', ').toUpperCase()}.`);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (f.size > MAX_BYTES) {
      toast.error(`Arquivo excede 5MB (${(f.size / 1024 / 1024).toFixed(1)}MB).`);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setFile(f);
    if (!title.trim()) {
      // Auto-fill title from filename (sem extensão).
      const stem = f.name.replace(/\.[^.]+$/, '');
      setTitle(stem);
    }
  }

  function handleSubmit() {
    if (title.trim().length === 0 || title.length > 200) {
      toast.error('Título inválido (1-200 caracteres).');
      return;
    }
    if (!file) {
      toast.error('Selecione um arquivo.');
      return;
    }

    const fd = new FormData();
    fd.append('title', title.trim());
    fd.append('file', file);

    startTransition(async () => {
      try {
        const result = await createKbDocumentAction(fd);
        if ('error' in result) {
          toast.error(`Falha no upload: ${result.error}`);
          return;
        }
        toast.success('Documento enviado. Aguardando aprovação.');
        reset();
        setOpen(false);
      } catch {
        toast.error('Falha inesperada ao enviar documento.');
      }
    });
  }

  return (
    <>
      <Button type="button" variant="default" onClick={() => setOpen(true)}>
        Adicionar documento
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adicionar documento à base de conhecimento</DialogTitle>
            <DialogDescription>
              Arquivos MD, TXT, PDF ou DOCX (até 5MB). O documento fica em &quot;pendente
              aprovação&quot; até um admin/owner aprovar; só depois a IA passa a usá-lo.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="kb-title">Título</Label>
              <Input
                id="kb-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ex: Procedimentos de agendamento"
                maxLength={200}
                disabled={isPending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kb-file">Arquivo</Label>
              <Input
                id="kb-file"
                type="file"
                accept={ACCEPT_MIME}
                onChange={handleFileChange}
                ref={fileInputRef}
                disabled={isPending}
              />
              {file && (
                <p className="text-[12px] text-[var(--luma-text-tertiary)]">
                  {file.name} · {(file.size / 1024).toFixed(1)} KB
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setOpen(false);
                reset();
              }}
              disabled={isPending}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="default"
              onClick={handleSubmit}
              disabled={isPending || !file || title.trim().length === 0}
            >
              {isPending ? 'Enviando...' : 'Enviar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

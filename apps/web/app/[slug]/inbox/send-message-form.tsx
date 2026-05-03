'use client';

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { sendMessageAction } from './actions';

interface SendMessageFormProps {
  conversationId: string;
}

export default function SendMessageForm({ conversationId }: SendMessageFormProps) {
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);

  async function submit() {
    const trimmed = content.trim();
    if (!trimmed || pending) return;
    setPending(true);
    try {
      const result = await sendMessageAction({ conversationId, content: trimmed });
      if ('error' in result && result.error) {
        toast.error(result.error);
        return;
      }
      setContent('');
      toast.success('Mensagem enviada.');
    } catch (e) {
      toast.error(`Falha ao enviar: ${(e as Error).message}`);
    } finally {
      setPending(false);
    }
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  const disabled = pending || content.trim().length === 0;

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-2 p-4 border-t border-[var(--luma-border)] bg-[var(--luma-bg-card)]">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKey}
        rows={2}
        placeholder="Digite uma mensagem... (Enter envia, Shift+Enter quebra linha)"
        className="flex-1 resize-none rounded-[8px] border border-[var(--luma-border)] bg-[var(--luma-bg)] px-3 py-2 text-[13.5px] focus:outline-none focus:border-[var(--luma-border-strong)] focus:ring-2 focus:ring-[var(--luma-accent-soft)]"
        disabled={pending}
      />
      <button
        type="submit"
        disabled={disabled}
        className="rounded-[8px] bg-[var(--luma-accent)] text-white text-[13px] font-medium px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
      >
        {pending ? 'Enviando…' : 'Enviar'}
      </button>
    </form>
  );
}

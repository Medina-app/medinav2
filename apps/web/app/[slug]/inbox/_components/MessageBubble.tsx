'use client';

import type { Message } from '@medina/chat';
import RelativeTime from '../relative-time';
import { getMessageVisualState, type MessageVisualState } from './message-visual-state';

interface MessageBubbleProps {
  message: Message;
  onRetry?: (messageId: string) => void;
}

export default function MessageBubble({ message: m, onRetry }: MessageBubbleProps) {
  const isOutbound = m.direction === 'outbound';
  const isAi = m.senderType === 'ai';
  const state = isOutbound ? getMessageVisualState(m) : null;
  const isFailed = state?.kind === 'failed';

  // Visual differentiation for AI-authored messages: subtle teal-tinted
  // bubble with a left-edge accent stripe + small "IA" label up top.
  // Reuses --luma-accent (teal) which already appears in the page glow,
  // so the bubble feels native to the design system rather than tagged on.
  const bubbleClass = isFailed
    ? 'bg-red-50 border border-red-200 text-[var(--luma-text-primary)]'
    : isAi
      ? 'bg-[rgba(14,165,233,0.06)] border border-[rgba(14,165,233,0.2)] border-l-2 border-l-[var(--luma-accent)] text-[var(--luma-text-primary)]'
      : isOutbound
        ? 'bg-[var(--luma-accent-soft)] text-[var(--luma-text-primary)]'
        : 'bg-[var(--luma-bg-card)] border border-[var(--luma-border)] text-[var(--luma-text-primary)]';

  return (
    <li className={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] rounded-[12px] px-3.5 py-2.5 ${bubbleClass}`}>
        {isAi ? (
          <span
            className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wide uppercase text-[#0369a1] mb-1"
            data-slot="ai-badge"
          >
            <span aria-hidden className="inline-block w-1 h-1 rounded-full bg-[var(--luma-accent)]" />
            IA
          </span>
        ) : null}
        <p className="text-[13.5px] whitespace-pre-wrap break-words">
          {m.content ?? <em className="opacity-60">(sem conteúdo)</em>}
        </p>
        <div className="flex items-center gap-1.5 mt-1">
          <RelativeTime
            date={m.createdAt}
            className="text-[10.5px] text-[var(--luma-text-tertiary)]"
          />
          {state ? <StatusIcon state={state} /> : null}
        </div>
        {isFailed ? (
          <div className="mt-1.5 flex items-center justify-between gap-2 pt-1.5 border-t border-red-200/60">
            <span
              className="text-[10.5px] text-red-700 truncate"
              title={state.error ?? 'Erro desconhecido'}
            >
              {state.error ?? 'Erro ao enviar'}
            </span>
            {onRetry ? (
              <button
                type="button"
                onClick={() => onRetry(m.id)}
                className="text-[10.5px] font-medium text-red-700 hover:text-red-800 underline-offset-2 hover:underline shrink-0"
              >
                Retentar
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function StatusIcon({ state }: { state: MessageVisualState }) {
  // All icons render in a fixed 12-pixel slot so the bubble's layout doesn't
  // shift when the state advances pending → sent → delivered.
  switch (state.kind) {
    case 'pending':
    case 'processing':
      return (
        <span
          aria-label={state.kind === 'pending' ? 'Em fila' : 'Enviando'}
          className="inline-flex items-center text-[var(--luma-text-tertiary)]"
        >
          <Spinner />
        </span>
      );
    case 'sent':
      return (
        <span aria-label="Enviada" className="inline-flex items-center text-[var(--luma-text-tertiary)]">
          <SingleCheck />
        </span>
      );
    case 'delivered':
      return (
        <span aria-label="Entregue" className="inline-flex items-center text-[var(--luma-text-tertiary)]">
          <DoubleCheck />
        </span>
      );
    case 'read':
      return (
        <span aria-label="Lida" className="inline-flex items-center text-blue-500">
          <DoubleCheck />
        </span>
      );
    case 'failed':
      return (
        <span aria-label="Falhou" className="inline-flex items-center text-red-600">
          <Warning />
        </span>
      );
  }
}

function Spinner() {
  return (
    <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.25" />
      <path
        d="M12 3 a9 9 0 0 1 9 9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function SingleCheck() {
  return (
    <svg width="13" height="11" viewBox="0 0 16 12" fill="none">
      <path d="M2 6.5 L6 10 L14 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function DoubleCheck() {
  return (
    <svg width="16" height="11" viewBox="0 0 20 12" fill="none">
      <path d="M2 6.5 L5.5 10 L13 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M7 6.5 L10.5 10 L18 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function Warning() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5 L15 14 L1 14 Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
      <path d="M8 6 L8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.8" r="0.7" fill="currentColor" />
    </svg>
  );
}

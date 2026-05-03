'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import type { ConversationWithMessages } from '@medina/chat';
import RelativeTime from './relative-time';
import SendMessageForm from './send-message-form';

interface ConversationDetailProps {
  conversation: ConversationWithMessages;
  clinicSlug: string;
}

const STATE_LABEL: Record<string, string> = {
  ai_handling: 'IA atendendo',
  awaiting_template_response: 'Aguardando template',
  waiting_human: 'Aguardando humano',
  assigned: 'Atribuída',
  paused: 'Pausada',
  resolved: 'Resolvida',
};

export default function ConversationDetail({ conversation, clinicSlug }: ConversationDetailProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversation.id, conversation.messages.length]);

  const headerName = conversation.patient?.fullName ?? conversation.externalId;
  const phone = conversation.patient?.phone ?? conversation.externalId;
  const stateLabel = STATE_LABEL[conversation.state] ?? conversation.state;

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--luma-border)] bg-[var(--luma-bg-card)]">
        <Link
          href={`/${clinicSlug}/inbox`}
          className="md:hidden text-[14px] text-[var(--luma-text-secondary)] hover:text-[var(--luma-text-primary)]"
        >
          ← Voltar
        </Link>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-[14px] text-[var(--luma-text-primary)] truncate">
            {headerName}
          </div>
          <div className="text-[12px] text-[var(--luma-text-tertiary)] truncate">{phone}</div>
        </div>
        <span className="text-[11px] font-medium text-[var(--luma-text-secondary)] bg-[var(--luma-bg-subtle)] rounded-full px-2.5 py-0.5">
          {stateLabel}
        </span>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 bg-[var(--luma-bg)]">
        {conversation.messages.length === 0 ? (
          <p className="text-center text-[13px] text-[var(--luma-text-tertiary)] mt-12">
            Nenhuma mensagem nesta conversa ainda.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {conversation.messages.map((m) => {
              const isOutbound = m.direction === 'outbound';
              return (
                <li
                  key={m.id}
                  className={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[75%] rounded-[12px] px-3.5 py-2.5 ${
                      isOutbound
                        ? 'bg-[var(--luma-accent-soft)] text-[var(--luma-text-primary)]'
                        : 'bg-[var(--luma-bg-card)] border border-[var(--luma-border)] text-[var(--luma-text-primary)]'
                    }`}
                  >
                    <p className="text-[13.5px] whitespace-pre-wrap break-words">
                      {m.content ?? <em className="opacity-60">(sem conteúdo)</em>}
                    </p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <RelativeTime
                        date={m.createdAt}
                        className="text-[10.5px] text-[var(--luma-text-tertiary)]"
                      />
                      {isOutbound ? (
                        <span className="text-[10px] text-[var(--luma-text-tertiary)]">
                          · {m.deliveryStatus}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <SendMessageForm conversationId={conversation.id} />
    </div>
  );
}

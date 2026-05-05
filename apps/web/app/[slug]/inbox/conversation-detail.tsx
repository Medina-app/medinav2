'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { ConversationWithMessages } from '@medina/chat';
import { toast } from 'sonner';
import { buildConversationChannel } from '@medina/realtime';
import SendMessageForm from './send-message-form';
import MessageBubble from './_components/MessageBubble';
import { hasActiveMessages } from './_components/has-active-messages';
import { retryFailedMessageAction } from './retry-action';
import { useCentrifugo } from '@/lib/realtime/use-centrifugo';

interface ConversationDetailProps {
  conversation: ConversationWithMessages;
  clinicSlug: string;
  clinicId: string;
}

const STATE_LABEL: Record<string, string> = {
  ai_handling: 'IA atendendo',
  awaiting_template_response: 'Aguardando template',
  waiting_human: 'Aguardando humano',
  assigned: 'Atribuída',
  paused: 'Pausada',
  resolved: 'Resolvida',
};

export default function ConversationDetail({
  conversation,
  clinicSlug,
  clinicId,
}: ConversationDetailProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [conversation.id, conversation.messages.length]);

  // CHAT-3: subscribe to the conversation's Centrifugo channel. Each event
  // triggers router.refresh() so Next.js re-fetches the canonical state from
  // the DB — we never trust the WS payload directly.
  const realtimeEnabled = process.env['NEXT_PUBLIC_REALTIME_ENABLED'] !== 'false';
  const channels = useMemo(
    () => [buildConversationChannel(clinicId, conversation.id)],
    [clinicId, conversation.id],
  );
  const { connected } = useCentrifugo({
    channels,
    onMessage: () => router.refresh(),
    enabled: realtimeEnabled,
  });

  // CHAT-2 polling kept as graceful-degradation fallback: only spins up when
  // realtime is unavailable AND there are messages in non-terminal states.
  // When the WS reconnects, `connected` flips true and the interval clears.
  const hasActive = hasActiveMessages(conversation.messages);

  useEffect(() => {
    if (connected) return;
    if (!hasActive) return;
    const id = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(id);
  }, [hasActive, router, connected]);

  async function handleRetry(messageId: string) {
    const result = await retryFailedMessageAction({ messageId });
    if ('error' in result && result.error) {
      toast.error(result.error);
      return;
    }
    toast.success('Reenfileirada.');
  }

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
            {conversation.messages.map((m) => (
              <MessageBubble key={m.id} message={m} onRetry={handleRetry} />
            ))}
          </ul>
        )}
      </div>

      <SendMessageForm conversationId={conversation.id} />
    </div>
  );
}

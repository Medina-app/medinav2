'use client';

import Link from 'next/link';
import type { ConversationListItem } from '@medina/chat';
import ConversationAvatar from './conversation-avatar';
import RelativeTime from './relative-time';

interface ConversationListProps {
  items: ConversationListItem[];
  selectedId: string | null;
  clinicSlug: string;
}

export default function ConversationList({ items, selectedId, clinicSlug }: ConversationListProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-12 gap-1 text-center">
        <p className="text-[13px] text-[var(--luma-text-secondary)]">Nenhuma conversa ainda.</p>
        <p className="text-[12px] text-[var(--luma-text-tertiary)]">
          As mensagens recebidas via WhatsApp aparecem aqui.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col">
      {items.map((c) => {
        const isActive = c.id === selectedId;
        const label = c.patientName ?? c.externalId;
        return (
          <li key={c.id} className="border-b border-[var(--luma-border)] last:border-b-0">
            <Link
              href={`/${clinicSlug}/inbox?conversation=${c.id}`}
              className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                isActive
                  ? 'bg-[var(--luma-bg-subtle)]'
                  : 'hover:bg-[var(--luma-bg-subtle)]'
              }`}
            >
              <ConversationAvatar seed={c.externalId} name={c.patientName} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-[14px] text-[var(--luma-text-primary)] truncate">
                    {label}
                  </span>
                  <RelativeTime
                    date={c.lastMessageAt}
                    className="text-[11px] text-[var(--luma-text-tertiary)] shrink-0"
                  />
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <span className="text-[12.5px] tracking-tight text-[var(--luma-text-secondary)] truncate">
                    {c.lastMessagePreview ?? '—'}
                  </span>
                  {c.unreadCount > 0 ? (
                    <span className="text-[10.5px] font-semibold bg-[var(--luma-accent)] text-white rounded-full px-2 py-[1px] shrink-0 leading-tight">
                      {c.unreadCount}
                    </span>
                  ) : null}
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

import { getTenantContext, getSupabaseServerClient } from '@medina/auth';
import { listConversations, getConversationWithMessages } from '@medina/chat';
import ConversationList from './conversation-list';
import ConversationDetail from './conversation-detail';
import EmptyState from './empty-state';
import InboxRealtimeWrapper from './_components/inbox-realtime-wrapper';

interface InboxPageProps {
  searchParams: Promise<{ conversation?: string }>;
}

export default async function InboxPage({ searchParams }: InboxPageProps) {
  const { conversation: convId } = await searchParams;
  const [ctx, sb] = await Promise.all([getTenantContext(), getSupabaseServerClient()]);
  const items = await listConversations(sb, ctx.clinicId, { includeResolved: false });
  const detail = convId ? await getConversationWithMessages(sb, ctx.clinicId, convId) : null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[360px_1fr] h-[calc(100vh-56px)] -m-6 md:-m-8">
      <div
        className={`${convId ? 'hidden md:block' : 'block'} border-r border-[var(--luma-border)] overflow-y-auto bg-[var(--luma-bg-card)]`}
      >
        <InboxRealtimeWrapper clinicId={ctx.clinicId} clinicSlug={ctx.clinicSlug}>
          <ConversationList
            items={items}
            selectedId={convId ?? null}
            clinicSlug={ctx.clinicSlug}
          />
        </InboxRealtimeWrapper>
      </div>
      <div className={`${convId ? 'block' : 'hidden md:block'} overflow-hidden`}>
        {detail ? (
          <ConversationDetail
            conversation={detail}
            clinicSlug={ctx.clinicSlug}
            clinicId={ctx.clinicId}
          />
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}

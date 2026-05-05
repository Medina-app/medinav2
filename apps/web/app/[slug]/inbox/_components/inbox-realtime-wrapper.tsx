'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCentrifugo } from '@/lib/realtime/use-centrifugo';
import { buildInboxChannel } from '@medina/realtime';

/**
 * Wraps the conversation list (server component output) with a client-side
 * Centrifugo subscription on the inbox channel. Fires `router.refresh()` on
 * each publication so the server re-fetches the list with the latest
 * last_message_at + unread_count.
 *
 * Kept as a thin shell so the rest of the inbox page stays a server
 * component — only the wrapper crosses the client boundary.
 */
export default function InboxRealtimeWrapper({
  clinicId,
  clinicSlug,
  children,
}: {
  clinicId: string;
  clinicSlug: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const enabled = process.env['NEXT_PUBLIC_REALTIME_ENABLED'] !== 'false';
  useCentrifugo({
    channels: [buildInboxChannel(clinicId)],
    onMessage: () => router.refresh(),
    enabled,
    clinicSlug,
  });
  return <>{children}</>;
}

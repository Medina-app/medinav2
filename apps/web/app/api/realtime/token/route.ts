import { NextResponse } from 'next/server';
import { getTenantContext, getSupabaseServerClient } from '@medina/auth';
import { listConversations } from '@medina/chat';
import {
  buildConversationChannel,
  buildInboxChannel,
  issueClientToken,
} from '@medina/realtime';

export async function GET(): Promise<NextResponse> {
  let ctx, sb;
  try {
    [ctx, sb] = await Promise.all([getTenantContext(), getSupabaseServerClient()]);
  } catch {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const secret = process.env['CENTRIFUGO_JWT_HMAC_SECRET'];
  const url = process.env['NEXT_PUBLIC_CENTRIFUGO_WSS_URL'];
  if (!secret || !url) {
    return NextResponse.json({ error: 'realtime not configured' }, { status: 503 });
  }

  const conversations = await listConversations(sb, ctx.clinicId, {
    includeResolved: false,
  });
  const channels = [
    buildInboxChannel(ctx.clinicId),
    ...conversations.map((c) => buildConversationChannel(ctx.clinicId, c.id)),
  ];

  const token = await issueClientToken({
    secret,
    userId: ctx.user.id,
    channels,
  });

  return NextResponse.json({ token, url });
}

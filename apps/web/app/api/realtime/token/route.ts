import { NextResponse, type NextRequest } from 'next/server';
import { assertTenantAccess, getSupabaseServerClient } from '@medina/auth';
import { listConversations } from '@medina/chat';
import {
  buildConversationChannel,
  buildInboxChannel,
  issueClientToken,
} from '@medina/realtime';

/**
 * Issues a Centrifugo client token scoped to the requested clinic.
 *
 * Why a query param instead of getTenantContext: the middleware only
 * injects x-tenant-slug on /[slug]/... requests; /api/* paths skip that
 * branch (RESERVED in middleware.ts), so getTenantContext throws
 * NoSessionError unconditionally inside an API route. The hook lives in
 * a [slug] tree and already knows the slug, so we pass it explicitly
 * and re-run assertTenantAccess (RLS-backed) for the same cross-tenant
 * guarantee getTenantContext would have given us.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const slug = req.nextUrl.searchParams.get('clinicSlug');
  if (!slug) {
    return NextResponse.json({ error: 'clinicSlug required' }, { status: 400 });
  }

  let userId: string;
  let clinicId: string;
  let sb;
  try {
    sb = await getSupabaseServerClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    const clinic = await assertTenantAccess(sb, slug);
    userId = user.id;
    clinicId = clinic.id;
  } catch {
    // assertTenantAccess throws TenantAccessDeniedError when the user
    // isn't a member of the requested clinic. Treat the same as no session.
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const secret = process.env['CENTRIFUGO_JWT_HMAC_SECRET'];
  const url = process.env['NEXT_PUBLIC_CENTRIFUGO_WSS_URL'];
  if (!secret || !url) {
    return NextResponse.json({ error: 'realtime not configured' }, { status: 503 });
  }

  const conversations = await listConversations(sb, clinicId, {
    includeResolved: false,
  });
  const channels = [
    buildInboxChannel(clinicId),
    ...conversations.map((c) => buildConversationChannel(clinicId, c.id)),
  ];

  const token = await issueClientToken({
    secret,
    userId,
    channels,
  });

  return NextResponse.json({ token, url });
}

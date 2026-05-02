import { NextResponse, type NextRequest } from 'next/server';
import {
  getSupabaseMiddlewareClient,
  assertTenantAccess,
  listUserClinics,
  TenantAccessDeniedError,
} from '@medina/auth';

// Segments that are NOT clinic slugs
const RESERVED_SEGMENTS = new Set(['login', 'signup', 'onboarding', 'api', '_next']);

export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request });
  const supabase = getSupabaseMiddlewareClient(request, response);

  // Always call getUser() — this refreshes the auth cookie if needed.
  // Do NOT use getSession() here: it does not validate the JWT server-side.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // ── Public routes ──────────────────────────────────────────────────────────
  if (
    pathname === '/' ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/signup') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/webhooks') ||
    pathname.startsWith('/_next') ||
    pathname.includes('favicon')
  ) {
    return response;
  }

  // ── Require auth ───────────────────────────────────────────────────────────
  if (!user) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // ── Tenant routing ─────────────────────────────────────────────────────────
  // First path segment is the clinic slug: /[slug]/...
  const firstSegment = pathname.split('/')[1];
  if (firstSegment && !RESERVED_SEGMENTS.has(firstSegment)) {
    try {
      await assertTenantAccess(supabase, firstSegment);

      // Inject x-tenant-slug so Server Components can read it via getTenantContext()
      const requestHeaders = new Headers(request.headers);
      requestHeaders.set('x-tenant-slug', firstSegment);
      const tenantResponse = NextResponse.next({ request: { headers: requestHeaders } });
      // Copy refreshed auth cookies with all attributes (httpOnly, secure, sameSite, etc.)
      response.cookies.getAll().forEach(({ name, value, ...options }) => {
        tenantResponse.cookies.set(name, value, options);
      });
      return tenantResponse;
    } catch (error) {
      if (error instanceof TenantAccessDeniedError) {
        // Redirect to the user's first accessible clinic, or onboarding
        try {
          const clinics = await listUserClinics(supabase);
          const first = clinics[0];
          if (first) {
            return NextResponse.redirect(new URL(`/${first.slug}`, request.url));
          }
        } catch {
          // ignore — fall through to onboarding
        }
        return NextResponse.redirect(new URL('/onboarding', request.url));
      }
      throw error;
    }
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, sitemap.xml, robots.txt
     * - image files
     */
    '/((?!_next/static|_next/image|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};

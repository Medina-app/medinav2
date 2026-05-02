import { createBrowserClient } from '@supabase/ssr';

let clientSingleton: ReturnType<typeof createBrowserClient> | undefined;

export function getSupabaseBrowserClient() {
  if (!clientSingleton) {
    clientSingleton = createBrowserClient(
      process.env['NEXT_PUBLIC_SUPABASE_URL']!,
      process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    );
  }
  return clientSingleton;
}

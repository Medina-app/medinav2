import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';

// Functions are registered here as they're added in subsequent commits of
// the CHAT-2 outbox sprint. The route is created with an empty list first
// so the Inngest CLI can discover the endpoint during local dev even before
// the worker functions exist.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [],
});

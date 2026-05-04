import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import {
  processOutboundMessage,
  onProcessOutboundFailure,
} from '@/lib/inngest/functions/process-outbound-message';
import { processMessageStatus } from '@/lib/inngest/functions/process-message-status';

// Same dev/cloud mode pattern as client.ts: only pass signingKey when it's
// actually set. Without it, the serve handler runs in dev mode and accepts
// the local Inngest CLI handshake without signature verification.
const signingKey = process.env['INNGEST_SIGNING_KEY'];

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processOutboundMessage, onProcessOutboundFailure, processMessageStatus],
  ...(signingKey ? { signingKey } : {}),
});

import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import {
  processOutboundMessage,
  onProcessOutboundFailure,
} from '@/lib/inngest/functions/process-outbound-message';
import { processMessageStatus } from '@/lib/inngest/functions/process-message-status';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processOutboundMessage, onProcessOutboundFailure, processMessageStatus],
});

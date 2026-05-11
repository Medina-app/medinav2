import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import {
  processOutboundMessage,
  onProcessOutboundFailure,
} from '@/lib/inngest/functions/process-outbound-message';
import { processMessageStatus } from '@/lib/inngest/functions/process-message-status';
import {
  dispatchAiAgent,
  onDispatchAiAgentFailure,
} from '@/lib/inngest/functions/dispatch-ai-agent';
import { reindexDocument } from '@/lib/inngest/functions/reindex-document';
import { processKbDocument } from '@/lib/inngest/functions/process-kb-document';
import { processCalcomEvent } from '@/lib/inngest/functions/process-calcom-event';
import { extractPatientFacts } from '@/lib/inngest/functions/extract-patient-facts';
import { expireOldFacts } from '@/lib/inngest/functions/expire-old-facts';

// signingKey + isDev are configured on the client (lib/inngest/client.ts)
// and inherited here, so the serve handler stays minimal.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    processOutboundMessage,
    onProcessOutboundFailure,
    processMessageStatus,
    dispatchAiAgent,
    onDispatchAiAgentFailure,
    reindexDocument,
    processKbDocument,
    processCalcomEvent,
    extractPatientFacts,
    expireOldFacts,
  ],
});

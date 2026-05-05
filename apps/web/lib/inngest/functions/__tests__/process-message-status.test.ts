import { describe, expect, it, vi } from 'vitest';
import {
  processMessageStatusHandler,
  type ProcessMessageStatusDeps,
} from '../process-message-status';

const fakeStep = {
  run: <T>(_name: string, fn: () => Promise<T>) => fn(),
};

describe('processMessageStatusHandler', () => {
  it('forwards event payload to updateDeliveryStatus and returns updated true', async () => {
    const deps: ProcessMessageStatusDeps = {
      updateDeliveryStatus: vi.fn().mockResolvedValue({ updated: true }),
    };

    const event = {
      data: {
        clinicId: 'clinic-1',
        externalMessageId: 'wamid.OUT-1',
        status: 'delivered' as const,
        deliveryError: undefined,
      },
    };

    const result = await processMessageStatusHandler(event, fakeStep, deps);

    expect(result).toEqual({ updated: true });
    expect(deps.updateDeliveryStatus).toHaveBeenCalledWith('clinic-1', {
      kind: 'status_update',
      externalMessageId: 'wamid.OUT-1',
      status: 'delivered',
      deliveryError: undefined,
    });
  });

  it('forwards deliveryError on failed status', async () => {
    const deps: ProcessMessageStatusDeps = {
      updateDeliveryStatus: vi.fn().mockResolvedValue({ updated: true }),
    };

    const event = {
      data: {
        clinicId: 'clinic-1',
        externalMessageId: 'wamid.FAIL-1',
        status: 'failed' as const,
        deliveryError: 're-engagement window expired',
      },
    };

    await processMessageStatusHandler(event, fakeStep, deps);

    expect(deps.updateDeliveryStatus).toHaveBeenCalledWith('clinic-1', {
      kind: 'status_update',
      externalMessageId: 'wamid.FAIL-1',
      status: 'failed',
      deliveryError: 're-engagement window expired',
    });
  });

  it('returns updated=false silently when helper rejects the transition (terminal guard)', async () => {
    // The state-guard logic lives in @medina/chat's updateMessageDeliveryStatus.
    // This worker just propagates the result; if the helper returns false (e.g.
    // a 'sent' callback arrived after 'delivered' already landed), the worker
    // does nothing else — Inngest sees a successful run, no retry.
    const deps: ProcessMessageStatusDeps = {
      updateDeliveryStatus: vi.fn().mockResolvedValue({ updated: false }),
    };

    const event = {
      data: {
        clinicId: 'clinic-1',
        externalMessageId: 'wamid.STALE',
        status: 'sent' as const,
        deliveryError: undefined,
      },
    };

    const result = await processMessageStatusHandler(event, fakeStep, deps);

    expect(result).toEqual({ updated: false });
  });
});

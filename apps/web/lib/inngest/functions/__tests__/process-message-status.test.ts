import { describe, expect, it, vi } from 'vitest';
import {
  processMessageStatusHandler,
  type ProcessMessageStatusDeps,
} from '../process-message-status';

const fakeStep = {
  run: <T>(_name: string, fn: () => Promise<T>) => fn(),
};

function makeDeps(overrides: Partial<ProcessMessageStatusDeps> = {}): ProcessMessageStatusDeps {
  return {
    updateDeliveryStatus: vi.fn().mockResolvedValue({
      updated: true,
      messageId: 'msg-1',
      conversationId: 'conv-1',
    }),
    ...overrides,
  };
}

describe('processMessageStatusHandler', () => {
  it('forwards event payload to updateDeliveryStatus and returns updated true', async () => {
    const deps = makeDeps();
    const event = {
      data: {
        clinicId: 'clinic-1',
        externalMessageId: 'wamid.OUT-1',
        status: 'delivered' as const,
        deliveryError: undefined,
      },
    };

    const result = await processMessageStatusHandler(event, fakeStep, deps);

    expect(result.updated).toBe(true);
    expect(deps.updateDeliveryStatus).toHaveBeenCalledWith('clinic-1', {
      kind: 'status_update',
      externalMessageId: 'wamid.OUT-1',
      status: 'delivered',
      deliveryError: undefined,
    });
  });

  it('forwards deliveryError on failed status', async () => {
    const deps = makeDeps();
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
    const deps = makeDeps({
      updateDeliveryStatus: vi.fn().mockResolvedValue({ updated: false }),
    });
    const event = {
      data: {
        clinicId: 'clinic-1',
        externalMessageId: 'wamid.STALE',
        status: 'sent' as const,
        deliveryError: undefined,
      },
    };

    const result = await processMessageStatusHandler(event, fakeStep, deps);

    expect(result.updated).toBe(false);
  });

  it('publishes message.updated to the conversation channel after a successful update', async () => {
    const publish = vi.fn();
    const deps = makeDeps({ publish });
    const event = {
      data: {
        clinicId: 'clinic-a',
        externalMessageId: 'wamid.OUT-1',
        status: 'delivered' as const,
        deliveryError: undefined,
      },
    };

    await processMessageStatusHandler(event, fakeStep, deps);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('clinic:clinic-a:conv:conv-1', {
      type: 'message.updated',
      conversationId: 'conv-1',
      messageId: 'msg-1',
    });
  });

  it('does NOT publish when the update was rejected by the terminal guard', async () => {
    const publish = vi.fn();
    const deps = makeDeps({
      publish,
      updateDeliveryStatus: vi.fn().mockResolvedValue({ updated: false }),
    });
    const event = {
      data: {
        clinicId: 'clinic-a',
        externalMessageId: 'wamid.STALE',
        status: 'sent' as const,
        deliveryError: undefined,
      },
    };

    await processMessageStatusHandler(event, fakeStep, deps);

    expect(publish).not.toHaveBeenCalled();
  });
});

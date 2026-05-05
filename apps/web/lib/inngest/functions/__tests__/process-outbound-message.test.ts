import { describe, expect, it, vi } from 'vitest';
import {
  processOutboundMessageHandler,
  onProcessOutboundFailureHandler,
  type ProcessOutboundDeps,
  type OnFailureDeps,
  type OutboxContextResult,
} from '../process-outbound-message';

const fakeStep = {
  run: <T>(_name: string, fn: () => Promise<T>) => fn(),
};

const baseEvent = {
  data: {
    messageId: 'msg-1',
    clinicId: 'clinic-1',
    conversationId: 'conv-1',
  },
};

function makeDeps(overrides: Partial<ProcessOutboundDeps> = {}): ProcessOutboundDeps {
  return {
    repo: {
      loadContext: vi.fn().mockResolvedValue({
        alreadySent: false,
        ctx: {
          integrationId: 'integ-1',
          phoneNumberId: '12345',
          toPhone: '+5581987654321',
          content: 'oi',
        },
      } satisfies OutboxContextResult),
      markProcessing: vi.fn().mockResolvedValue(undefined),
      persistSuccess: vi.fn().mockResolvedValue(undefined),
      persistFailure: vi.fn().mockResolvedValue(undefined),
    },
    decryptCredential: vi.fn().mockResolvedValue({ api_key: 'kapso-key-xyz' }),
    fetchKapso: vi.fn().mockResolvedValue({ wamid: 'wamid.OUT-1' }),
    ...overrides,
  };
}

const baseFailureEvent = {
  data: {
    event: { data: { messageId: 'msg-failed', clinicId: 'clinic-1', conversationId: 'conv-1' } },
    error: { message: 'kapso 503 service unavailable' },
    attempts: 5,
  },
};

describe('processOutboundMessageHandler', () => {
  it('happy path: marks processing → decrypts → POSTs → persists success with wamid', async () => {
    const deps = makeDeps();
    const result = await processOutboundMessageHandler(baseEvent, fakeStep, deps);

    expect(result).toEqual({ sent: true });
    expect(deps.repo.markProcessing).toHaveBeenCalledWith('msg-1');
    expect(deps.decryptCredential).toHaveBeenCalledWith('integ-1');
    expect(deps.fetchKapso).toHaveBeenCalledWith({
      apiKey: 'kapso-key-xyz',
      phoneNumberId: '12345',
      toPhone: '+5581987654321',
      content: 'oi',
    });
    expect(deps.repo.persistSuccess).toHaveBeenCalledWith('msg-1', 'wamid.OUT-1');
  });

  it('idempotent: returns skipped when outbox_status is already sent', async () => {
    const deps = makeDeps({
      repo: {
        loadContext: vi.fn().mockResolvedValue({ alreadySent: true } satisfies OutboxContextResult),
        markProcessing: vi.fn(),
        persistSuccess: vi.fn(),
        persistFailure: vi.fn(),
      },
    });
    const result = await processOutboundMessageHandler(baseEvent, fakeStep, deps);

    expect(result).toEqual({ skipped: 'already_sent' });
    expect(deps.repo.markProcessing).not.toHaveBeenCalled();
    expect(deps.decryptCredential).not.toHaveBeenCalled();
    expect(deps.fetchKapso).not.toHaveBeenCalled();
    expect(deps.repo.persistSuccess).not.toHaveBeenCalled();
  });

  it('throws on Kapso fetch error so Inngest retries (no persistSuccess called)', async () => {
    const deps = makeDeps({
      fetchKapso: vi.fn().mockRejectedValue(new Error('kapso 503 service unavailable')),
    });

    await expect(processOutboundMessageHandler(baseEvent, fakeStep, deps)).rejects.toThrow(
      /kapso 503/,
    );
    expect(deps.repo.persistSuccess).not.toHaveBeenCalled();
    // markProcessing was already called before the throw — that's fine, it
    // signals the retry attempt is in flight.
    expect(deps.repo.markProcessing).toHaveBeenCalled();
  });

  it('throws on credential decrypt error so Inngest retries', async () => {
    const deps = makeDeps({
      decryptCredential: vi.fn().mockRejectedValue(new Error('vault unavailable')),
    });

    await expect(processOutboundMessageHandler(baseEvent, fakeStep, deps)).rejects.toThrow(
      /vault unavailable/,
    );
    expect(deps.fetchKapso).not.toHaveBeenCalled();
    expect(deps.repo.persistSuccess).not.toHaveBeenCalled();
  });

  it('publishes message.updated to the conversation channel after persistSuccess', async () => {
    const publish = vi.fn();
    const deps = makeDeps({ publish });
    await processOutboundMessageHandler(baseEvent, fakeStep, deps);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('clinic:clinic-1:conv:conv-1', {
      type: 'message.updated',
      conversationId: 'conv-1',
      messageId: 'msg-1',
    });
  });

  it('does NOT publish when the message was already sent (idempotent skip)', async () => {
    const publish = vi.fn();
    const deps = makeDeps({
      publish,
      repo: {
        loadContext: vi.fn().mockResolvedValue({ alreadySent: true } satisfies OutboxContextResult),
        markProcessing: vi.fn(),
        persistSuccess: vi.fn(),
        persistFailure: vi.fn(),
      },
    });
    await processOutboundMessageHandler(baseEvent, fakeStep, deps);
    expect(publish).not.toHaveBeenCalled();
  });

  it('throws when message context cannot be loaded (e.g. row missing)', async () => {
    const deps = makeDeps({
      repo: {
        loadContext: vi.fn().mockRejectedValue(new Error('message msg-1 not found')),
        markProcessing: vi.fn(),
        persistSuccess: vi.fn(),
        persistFailure: vi.fn(),
      },
    });

    await expect(processOutboundMessageHandler(baseEvent, fakeStep, deps)).rejects.toThrow(
      /msg-1 not found/,
    );
  });
});

describe('onProcessOutboundFailureHandler', () => {
  it('marks message failed with truncated error + last_error_at + retry_count', async () => {
    const persistFailure = vi.fn().mockResolvedValue(undefined);
    const deps: OnFailureDeps = { persistFailure };
    const longError = 'x'.repeat(800); // longer than 500 char truncation limit
    const event = {
      data: {
        event: { data: { messageId: 'msg-failed', clinicId: 'clinic-1', conversationId: 'conv-1' } },
        error: { message: longError },
        attempts: 5,
      },
    };

    await onProcessOutboundFailureHandler(event, deps);

    expect(persistFailure).toHaveBeenCalledTimes(1);
    const call = persistFailure.mock.calls[0]!;
    expect(call[0]).toBe('msg-failed');
    expect(call[1]).toHaveLength(500); // truncated
    expect(call[2]).toBe(5); // retry_count
  });

  it('defaults retry_count to 5 if attempts is missing', async () => {
    const persistFailure = vi.fn().mockResolvedValue(undefined);
    const event = {
      data: {
        event: { data: { messageId: 'msg-x', clinicId: 'c', conversationId: 'cv' } },
        error: { message: 'short err' },
      },
    };

    await onProcessOutboundFailureHandler(event, { persistFailure });

    expect(persistFailure).toHaveBeenCalledWith('msg-x', 'short err', 5);
  });

  it('publishes message.updated to the conversation channel after persistFailure', async () => {
    const persistFailure = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn();
    await onProcessOutboundFailureHandler(baseFailureEvent, { persistFailure, publish });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('clinic:clinic-1:conv:conv-1', {
      type: 'message.updated',
      conversationId: 'conv-1',
      messageId: 'msg-failed',
    });
  });
});

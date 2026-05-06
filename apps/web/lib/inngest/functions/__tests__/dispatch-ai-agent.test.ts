import { describe, expect, it, vi } from 'vitest';
import { AgentDispatchSkipped } from '@medina/ai';
import {
  dispatchAiAgentHandler,
  onDispatchAiAgentFailureHandler,
  type DispatchAiAgentDeps,
  type DispatchAiAgentEvent,
  type OnDispatchAiAgentFailureEvent,
  type OnDispatchAiAgentFailureDeps,
} from '../dispatch-ai-agent';

const fakeStep = {
  run: <T>(_name: string, fn: () => Promise<T>) => fn(),
  sendEvent: vi.fn().mockResolvedValue(undefined),
};

function makeDeps(overrides: Partial<DispatchAiAgentDeps> = {}): DispatchAiAgentDeps {
  return {
    dispatchAgent: vi.fn().mockResolvedValue({
      messageId: 'msg-out-1',
      traceId: 'trace-1',
      tokensIn: 120,
      tokensOut: 18,
    }),
    ...overrides,
  };
}

const baseEvent: DispatchAiAgentEvent = {
  data: {
    messageId: 'msg-in-1',
    conversationId: 'conv-1',
    clinicId: 'clinic-1',
  },
};

describe('dispatchAiAgentHandler', () => {
  it('runs dispatchAgent with the event payload and queues the outbound message', async () => {
    const deps = makeDeps();
    fakeStep.sendEvent.mockClear();

    const result = await dispatchAiAgentHandler(baseEvent, fakeStep, deps);

    expect(deps.dispatchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-in-1',
        conversationId: 'conv-1',
        clinicId: 'clinic-1',
      }),
    );
    expect(fakeStep.sendEvent).toHaveBeenCalledWith(
      'queue-outbound',
      expect.objectContaining({
        name: 'chat/message.outbound',
        data: { messageId: 'msg-out-1' },
      }),
    );
    expect(result).toEqual({
      messageId: 'msg-out-1',
      tokensIn: 120,
      tokensOut: 18,
    });
  });

  it('returns { skipped: reason } when dispatchAgent throws AgentDispatchSkipped (no retry)', async () => {
    const deps = makeDeps({
      dispatchAgent: vi.fn().mockRejectedValue(new AgentDispatchSkipped('state_not_ai_handling')),
    });
    fakeStep.sendEvent.mockClear();

    const result = await dispatchAiAgentHandler(baseEvent, fakeStep, deps);

    expect(result).toEqual({ skipped: 'state_not_ai_handling' });
    expect(fakeStep.sendEvent).not.toHaveBeenCalled();
  });

  it('returns skipped when no agent_config (Inngest treats as success — no retry)', async () => {
    const deps = makeDeps({
      dispatchAgent: vi.fn().mockRejectedValue(new AgentDispatchSkipped('no_agent_config')),
    });
    const result = await dispatchAiAgentHandler(baseEvent, fakeStep, deps);
    expect(result).toEqual({ skipped: 'no_agent_config' });
  });

  it('propagates non-skipped errors so Inngest retries (LLM rate limit, DB error)', async () => {
    const deps = makeDeps({
      dispatchAgent: vi.fn().mockRejectedValue(new Error('rate limit')),
    });
    await expect(dispatchAiAgentHandler(baseEvent, fakeStep, deps)).rejects.toThrow('rate limit');
  });

  it('does NOT queue outbound when dispatchAgent throws (regardless of error kind)', async () => {
    const deps = makeDeps({
      dispatchAgent: vi.fn().mockRejectedValue(new Error('llm timeout')),
    });
    fakeStep.sendEvent.mockClear();
    await expect(dispatchAiAgentHandler(baseEvent, fakeStep, deps)).rejects.toThrow();
    expect(fakeStep.sendEvent).not.toHaveBeenCalled();
  });
});

describe('onDispatchAiAgentFailureHandler', () => {
  function makeFailureDeps(
    overrides: Partial<OnDispatchAiAgentFailureDeps> = {},
  ): OnDispatchAiAgentFailureDeps {
    return {
      persistAiFailure: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  const baseFailureEvent: OnDispatchAiAgentFailureEvent = {
    data: {
      function_id: 'dispatch-ai-agent',
      event: { data: { messageId: 'msg-in-1', conversationId: 'conv-1', clinicId: 'clinic-1' } },
      error: { message: 'rate limit exceeded' },
      attempts: 3,
    },
  };

  it('persists ai failure with error message + attempt count', async () => {
    const deps = makeFailureDeps();
    await onDispatchAiAgentFailureHandler(baseFailureEvent, deps);
    expect(deps.persistAiFailure).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      clinicId: 'clinic-1',
      errorMessage: 'rate limit exceeded',
      retryCount: 3,
    });
  });

  it('truncates error message to 500 chars', async () => {
    const deps = makeFailureDeps();
    const longError = 'x'.repeat(700);
    await onDispatchAiAgentFailureHandler(
      {
        ...baseFailureEvent,
        data: { ...baseFailureEvent.data, error: { message: longError } },
      },
      deps,
    );
    const call = vi.mocked(deps.persistAiFailure).mock.calls[0]?.[0];
    expect(call?.errorMessage.length).toBe(500);
  });

  it('defaults retryCount to 2 when attempts is undefined (matches Inngest retries=2)', async () => {
    const deps = makeFailureDeps();
    await onDispatchAiAgentFailureHandler(
      {
        ...baseFailureEvent,
        data: { ...baseFailureEvent.data, attempts: undefined },
      },
      deps,
    );
    const call = vi.mocked(deps.persistAiFailure).mock.calls[0]?.[0];
    expect(call?.retryCount).toBe(2);
  });
});

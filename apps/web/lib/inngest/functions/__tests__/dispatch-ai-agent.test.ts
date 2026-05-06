import { describe, expect, it, vi } from 'vitest';
import { AgentDispatchSkipped } from '@medina/ai';
import {
  dispatchAiAgentHandler,
  type DispatchAiAgentDeps,
  type DispatchAiAgentEvent,
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

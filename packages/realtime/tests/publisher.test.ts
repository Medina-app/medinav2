import { describe, it, expect, vi, beforeEach } from 'vitest';
import { publishToChannel, publishToChannelFireAndForget, type PublisherDeps } from '../src/publisher';

const baseDeps = (overrides: Partial<PublisherDeps> = {}): PublisherDeps => ({
  apiUrl: 'https://ws.example.test/api',
  apiKey: 'k-secret',
  fetchImpl: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
  ...overrides,
});

describe('publishToChannel', () => {
  it('POSTs to centrifugo /api with apikey auth header + correct body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('{"result":{}}', { status: 200 }));
    await publishToChannel(baseDeps({ fetchImpl }), 'clinic:c1:inbox', {
      type: 'message.new',
      conversationId: 'conv-1',
      messageId: 'msg-1',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe('https://ws.example.test/api');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('apikey k-secret');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      method: 'publish',
      params: {
        channel: 'clinic:c1:inbox',
        data: { type: 'message.new', conversationId: 'conv-1', messageId: 'msg-1' },
      },
    });
  });

  it('throws on non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(
      publishToChannel(baseDeps({ fetchImpl }), 'clinic:c1:inbox', {
        type: 'conversation.updated',
        conversationId: 'c',
      }),
    ).rejects.toThrow(/centrifugo publish failed/);
  });

  it('throws when centrifugo body has error field even on HTTP 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        '{"error":{"code":109,"message":"unknown channel"}}',
        { status: 200 },
      ),
    );
    await expect(
      publishToChannel(baseDeps({ fetchImpl }), 'clinic:c1:inbox', {
        type: 'conversation.updated',
        conversationId: 'c',
      }),
    ).rejects.toThrow(/unknown channel/);
  });
});

describe('publishToChannelFireAndForget', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns void synchronously and never throws on publish failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const ret = publishToChannelFireAndForget(
      baseDeps({ fetchImpl }),
      'clinic:c1:inbox',
      { type: 'conversation.updated', conversationId: 'c' },
    );
    expect(ret).toBeUndefined();
    // Give the microtask queue a turn so the .catch runs.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { calcomAdapter } from '../adapter.js';
import type { WebhookContext } from '@medina/integrations-core';
import type { ClinicIntegration } from '@medina/db';

function makeIntegration(): ClinicIntegration {
  return {
    id: 'integ-1',
    clinicId: 'clinic-1',
    type: 'calcom',
    provider: 'calcom',
    status: 'active',
    webhookSecret: 'whatever',
    config: {},
    encryptedCredentials: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    webhookPath: null,
  } as unknown as ClinicIntegration;
}

function makeCtx(payload: unknown, opts: { inngestSend?: typeof vi.fn } = {}): WebhookContext {
  return {
    clinicId: 'clinic-1',
    integration: makeIntegration(),
    payload,
    headers: { 'x-cal-signature-256': 'sig' },
    rawBody: JSON.stringify(payload),
    inngestSend: opts.inngestSend ?? (vi.fn().mockResolvedValue({ ids: ['evt-1'] }) as never),
  };
}

describe('calcomAdapter (AI-4 Task 2)', () => {
  it('exposes type, provider, signatureHeader', () => {
    expect(calcomAdapter.type).toBe('calcom');
    expect(calcomAdapter.provider).toBe('calcom');
    expect(calcomAdapter.signatureHeader).toBe('x-cal-signature-256');
  });

  it('BOOKING_CREATED → dispatcha Inngest com event ID idempotente calcom:{uid}:{trigger}', async () => {
    const inngestSend = vi.fn().mockResolvedValue({ ids: ['evt-1'] });
    const ctx = makeCtx(
      {
        triggerEvent: 'BOOKING_CREATED',
        createdAt: '2026-06-01T00:00:00Z',
        payload: {
          uid: 'booking-uid-123',
          bookingId: 999,
          eventTypeId: 42,
          startTime: '2026-06-01T10:00:00Z',
          endTime: '2026-06-01T10:30:00Z',
          attendees: [{ email: 'p@x.com', name: 'João' }],
        },
      },
      { inngestSend: inngestSend as never },
    );

    const result = await calcomAdapter.handle(ctx);

    expect(result).toEqual({ processed: true, reason: 'dispatched' });
    expect(inngestSend).toHaveBeenCalledOnce();
    const callArg = inngestSend.mock.calls[0]?.[0] as { name: string; id: string; data: unknown };
    expect(callArg.name).toBe('calcom/booking.received');
    expect(callArg.id).toBe('calcom:booking-uid-123:BOOKING_CREATED');
    expect(callArg.data).toMatchObject({
      clinicId: 'clinic-1',
      integrationId: 'integ-1',
      triggerEvent: 'BOOKING_CREATED',
      uid: 'booking-uid-123',
    });
  });

  it.each(['BOOKING_CONFIRMED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'] as const)(
    '%s → dispatcha Inngest também',
    async (trigger) => {
      const inngestSend = vi.fn().mockResolvedValue({});
      const ctx = makeCtx(
        {
          triggerEvent: trigger,
          createdAt: '2026-06-01T00:00:00Z',
          payload: {
            uid: 'uid-X',
            eventTypeId: 42,
            startTime: '2026-06-01T10:00:00Z',
            endTime: '2026-06-01T10:30:00Z',
            attendees: [],
          },
        },
        { inngestSend: inngestSend as never },
      );
      const r = await calcomAdapter.handle(ctx);
      expect(r.processed).toBe(true);
      expect(inngestSend).toHaveBeenCalledOnce();
    },
  );

  it('triggerEvent desconhecido → no-op (não throw, idempotência)', async () => {
    const inngestSend = vi.fn();
    const ctx = makeCtx(
      { triggerEvent: 'BOOKING_PAYMENT_INITIATED', payload: { uid: 'x' } },
      { inngestSend: inngestSend as never },
    );
    const r = await calcomAdapter.handle(ctx);
    expect(r).toEqual({ processed: false, reason: 'unhandled_trigger' });
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it('payload sem uid → erro estruturado (não throw — adapter loga e ack 200)', async () => {
    const inngestSend = vi.fn();
    const ctx = makeCtx(
      { triggerEvent: 'BOOKING_CREATED', payload: { eventTypeId: 42 } },
      { inngestSend: inngestSend as never },
    );
    const r = await calcomAdapter.handle(ctx);
    expect(r).toEqual({ processed: false, reason: 'invalid_payload' });
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it('inngestSend ausente → throw InngestDispatchError (entrypoint missing)', async () => {
    const ctx: WebhookContext = {
      clinicId: 'clinic-1',
      integration: makeIntegration(),
      payload: {
        triggerEvent: 'BOOKING_CREATED',
        payload: { uid: 'x', eventTypeId: 42, startTime: '2026', endTime: '2026', attendees: [] },
      },
      headers: {},
      rawBody: '{}',
    };
    await expect(calcomAdapter.handle(ctx)).rejects.toThrow();
  });
});

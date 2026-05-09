import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CalcomClient } from '../client.js';
import {
  CalApiError,
  CalBookingNotFoundError,
  CalSlotConflictError,
  CalUnavailableError,
} from '../errors.js';

const BASE = 'https://cal.medina.app/api/v2';
const KEY = 'cal_test_xxx';

function makeFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn();
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CalcomClient (AI-4)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('getAvailability: GET /slots com auth + version + query params', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          slots: {
            '2026-06-01': [{ start: '2026-06-01T10:00:00Z', end: '2026-06-01T10:30:00Z' }],
          },
        },
      }),
    );
    const client = new CalcomClient({ baseUrl: BASE, apiKey: KEY });

    const slots = await client.getAvailability({
      eventTypeId: 42,
      startTime: '2026-06-01T00:00:00Z',
      endTime: '2026-06-02T00:00:00Z',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const callArg = fetchMock.mock.calls[0]?.[0] as string;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(callArg).toContain(`${BASE}/slots`);
    expect(callArg).toContain('eventTypeId=42');
    expect(callArg).toContain('startTime=');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(headers['cal-api-version']).toBe('2024-08-13');
    expect(slots).toEqual([{ start: '2026-06-01T10:00:00Z', end: '2026-06-01T10:30:00Z' }]);
  });

  it('createBooking: POST /bookings com body + retorna {uid,id}', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        data: {
          id: 999,
          uid: 'abc123',
          eventTypeId: 42,
          startTime: '2026-06-01T10:00:00Z',
          endTime: '2026-06-01T10:30:00Z',
          status: 'ACCEPTED',
          attendees: [{ email: 'p@x.com', name: 'João' }],
        },
      }),
    );
    const client = new CalcomClient({ baseUrl: BASE, apiKey: KEY });

    const booking = await client.createBooking({
      eventTypeId: 42,
      start: '2026-06-01T10:00:00Z',
      attendee: { email: 'p@x.com', name: 'João', timeZone: 'America/Sao_Paulo' },
    });

    expect(booking.uid).toBe('abc123');
    expect(booking.id).toBe(999);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.eventTypeId).toBe(42);
    expect(body.attendee.email).toBe('p@x.com');
  });

  it('cancelBooking: POST /bookings/{uid}/cancel + reason no body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'success' }));
    const client = new CalcomClient({ baseUrl: BASE, apiKey: KEY });

    await client.cancelBooking('abc123', 'paciente desistiu');

    const url = fetchMock.mock.calls[0]?.[0] as string;
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(url).toBe(`${BASE}/bookings/abc123/cancel`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.cancellationReason).toBe('paciente desistiu');
  });

  it('rescheduleBooking: POST /bookings/{uid}/reschedule retorna novo uid', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        data: {
          id: 1000,
          uid: 'newuid',
          eventTypeId: 42,
          startTime: '2026-06-02T10:00:00Z',
          endTime: '2026-06-02T10:30:00Z',
          status: 'ACCEPTED',
          attendees: [{ email: 'p@x.com', name: 'João' }],
        },
      }),
    );
    const client = new CalcomClient({ baseUrl: BASE, apiKey: KEY });

    const booking = await client.rescheduleBooking('abc123', '2026-06-02T10:00:00Z');

    expect(booking.uid).toBe('newuid');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.start).toBe('2026-06-02T10:00:00Z');
  });

  it('cancelBooking 404 → CalBookingNotFoundError (graceful pra worker idempotente)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }));
    const client = new CalcomClient({ baseUrl: BASE, apiKey: KEY });
    await expect(client.cancelBooking('zzz', 'reason')).rejects.toBeInstanceOf(
      CalBookingNotFoundError,
    );
  });

  it('createBooking 409 conflict → CalSlotConflictError (slot já tomado)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'slot taken' }));
    const client = new CalcomClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.createBooking({
        eventTypeId: 42,
        start: '2026-06-01T10:00:00Z',
        attendee: { email: 'p@x.com', name: 'João', timeZone: 'America/Sao_Paulo' },
      }),
    ).rejects.toBeInstanceOf(CalSlotConflictError);
  });

  it('401 → CalApiError (auth quebrou — sem retry, propaga immediate)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));
    const client = new CalcomClient({ baseUrl: BASE, apiKey: KEY });
    await expect(
      client.getAvailability({
        eventTypeId: 42,
        startTime: '2026-06-01T00:00:00Z',
        endTime: '2026-06-02T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(CalApiError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('429 rate limit → retry exp backoff até 3x → eventual success', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { error: 'rate limit' }))
      .mockResolvedValueOnce(jsonResponse(429, { error: 'rate limit' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { slots: { '2026-06-01': [{ start: '2026-06-01T10:00:00Z', end: '2026-06-01T10:30:00Z' }] } },
        }),
      );
    const client = new CalcomClient({ baseUrl: BASE, apiKey: KEY, retryDelayMs: 1 });
    const slots = await client.getAvailability({
      eventTypeId: 42,
      startTime: '2026-06-01T00:00:00Z',
      endTime: '2026-06-02T00:00:00Z',
    });
    expect(slots).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('429 sempre → CalUnavailableError após 3 retries', async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { error: 'rate limit' }));
    const client = new CalcomClient({ baseUrl: BASE, apiKey: KEY, retryDelayMs: 1 });
    await expect(
      client.getAvailability({
        eventTypeId: 42,
        startTime: '2026-06-01T00:00:00Z',
        endTime: '2026-06-02T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(CalUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });
});

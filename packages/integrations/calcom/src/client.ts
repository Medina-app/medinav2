/**
 * AI-4 Cal.com self-host API v2 HTTP client.
 *
 * - Bearer auth + cal-api-version: 2024-08-13
 * - Retry exp backoff em 429/5xx (max 3 attempts)
 * - Mapeia status codes pra erros tipados (CalApiError, CalBookingNotFoundError,
 *   CalSlotConflictError, CalUnavailableError)
 * - Sem retry em 4xx (exceto 429) — auth/validation falham imediato
 */
import {
  CalApiError,
  CalBookingNotFoundError,
  CalSlotConflictError,
  CalUnavailableError,
} from './errors.js';
import type { CalAvailabilitySlot, CalBooking, CalCreateBookingInput } from './types.js';

const CAL_API_VERSION = '2024-08-13';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

interface CalcomClientOpts {
  baseUrl: string;
  apiKey: string;
  /** Override pra tests acelerarem retries. */
  retryDelayMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

interface ApiResponse<T> {
  data?: T;
  error?: { message?: string; code?: string };
}

export class CalcomClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(opts: CalcomClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getAvailability(args: {
    eventTypeId: number;
    startTime: string;
    endTime: string;
  }): Promise<CalAvailabilitySlot[]> {
    const params = new URLSearchParams({
      eventTypeId: String(args.eventTypeId),
      startTime: args.startTime,
      endTime: args.endTime,
    });
    const url = `${this.baseUrl}/slots?${params.toString()}`;
    const res = await this.requestWithRetry(url, { method: 'GET' });
    const json = (await res.json()) as ApiResponse<{
      slots: Record<string, CalAvailabilitySlot[]>;
    }>;
    const slotsByDate = json.data?.slots ?? {};
    // Flatten: { '2026-06-01': [slot1, slot2], ... } → [slot1, slot2, ...]
    return Object.values(slotsByDate).flat();
  }

  async createBooking(input: CalCreateBookingInput): Promise<CalBooking> {
    const url = `${this.baseUrl}/bookings`;
    const res = await this.requestWithRetry(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const json = (await res.json()) as ApiResponse<CalBooking>;
    if (!json.data) {
      throw new CalApiError({ status: res.status, body: json, message: 'createBooking: missing data' });
    }
    return json.data;
  }

  async cancelBooking(uid: string, cancellationReason: string): Promise<void> {
    const url = `${this.baseUrl}/bookings/${encodeURIComponent(uid)}/cancel`;
    await this.requestWithRetry(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cancellationReason }),
    });
  }

  async rescheduleBooking(uid: string, newStart: string): Promise<CalBooking> {
    const url = `${this.baseUrl}/bookings/${encodeURIComponent(uid)}/reschedule`;
    const res = await this.requestWithRetry(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ start: newStart }),
    });
    const json = (await res.json()) as ApiResponse<CalBooking>;
    if (!json.data) {
      throw new CalApiError({ status: res.status, body: json, message: 'rescheduleBooking: missing data' });
    }
    return json.data;
  }

  async getBooking(uid: string): Promise<CalBooking> {
    const url = `${this.baseUrl}/bookings/${encodeURIComponent(uid)}`;
    const res = await this.requestWithRetry(url, { method: 'GET' });
    const json = (await res.json()) as ApiResponse<CalBooking>;
    if (!json.data) {
      throw new CalApiError({ status: res.status, body: json, message: 'getBooking: missing data' });
    }
    return json.data;
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private async requestWithRetry(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'cal-api-version': CAL_API_VERSION,
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchWithTimeout(url, { ...init, headers });
        // Retry-eligible status: 429 + 5xx
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          if (attempt < this.maxRetries) {
            await this.sleep(this.retryDelayMs * Math.pow(2, attempt));
            continue;
          }
          // Esgotou retries — body lido pra debug, mas erro genérico.
          const body = await this.safeJson(res);
          throw new CalUnavailableError({ status: res.status, body });
        }
        if (!res.ok) {
          await this.throwTypedError(res, url);
        }
        return res;
      } catch (err) {
        lastErr = err;
        // Erros já-tipados não retentam — propagam imediato.
        if (err instanceof CalApiError || err instanceof CalUnavailableError) {
          throw err;
        }
        // Network/timeout — retry se ainda tem attempt.
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryDelayMs * Math.pow(2, attempt));
          continue;
        }
        throw new CalUnavailableError(err);
      }
    }
    // Unreachable, mas TS quer return.
    throw new CalUnavailableError(lastErr);
  }

  private async throwTypedError(res: Response, url: string): Promise<never> {
    const body = await this.safeJson(res);
    if (res.status === 404 || res.status === 410) {
      // Extrai uid do url pra contexto.
      const match = /\/bookings\/([^/]+)/.exec(url);
      const uid = match ? decodeURIComponent(match[1] ?? '') : 'unknown';
      throw new CalBookingNotFoundError(uid, body);
    }
    if (res.status === 409) {
      throw new CalSlotConflictError(body);
    }
    const code = (body as { error?: { code?: string } })?.error?.code;
    throw new CalApiError({ status: res.status, code: code ?? undefined, body });
  }

  private async safeJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

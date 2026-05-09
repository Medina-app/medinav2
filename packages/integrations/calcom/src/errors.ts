/**
 * AI-4: Errors tipados pra CalcomClient. Permitem branching no caller
 * (tool agent) entre "slot já tomado" (informa paciente) vs "auth quebrou"
 * (escala pra humano com debug info).
 */

export class CalApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;
  constructor(args: { status: number; code?: string; body?: unknown; message?: string }) {
    super(args.message ?? `Cal.com API error (status=${args.status}, code=${args.code ?? 'unknown'})`);
    this.name = 'CalApiError';
    this.status = args.status;
    this.code = args.code;
    this.body = args.body;
  }
}

/** 404 ou 410 — booking já cancelado/inexistente. Tools tratam como graceful. */
export class CalBookingNotFoundError extends CalApiError {
  constructor(uid: string, body?: unknown) {
    super({ status: 404, code: 'booking_not_found', body, message: `Booking ${uid} not found in Cal.com` });
    this.name = 'CalBookingNotFoundError';
  }
}

/** 409 — slot já tomado por outro paciente. Tool agente informa e oferece outro slot. */
export class CalSlotConflictError extends CalApiError {
  constructor(body?: unknown) {
    super({ status: 409, code: 'slot_conflict', body, message: 'Selected time slot is no longer available' });
    this.name = 'CalSlotConflictError';
  }
}

/** Network/timeout durante retry. Indistinguível de upstream down. */
export class CalUnavailableError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super('Cal.com unreachable after retries');
    this.name = 'CalUnavailableError';
    this.cause = cause;
  }
}

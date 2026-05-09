/**
 * AI-4 Cal.com self-host API v2 types.
 *
 * Cal.com self-host (cal-api-version: 2024-08-13). Endpoints relevantes pro
 * agente IA: slots, bookings (create/cancel/reschedule/get).
 *
 * Refs: https://cal.com/docs/api-reference/v2 (self-host segue v2 API).
 */

/** Slot disponível pra agendar. start/end ISO 8601 UTC. */
export interface CalAvailabilitySlot {
  start: string;
  end: string;
}

/** Booking criado/lido via Cal.com. UID é stable across reschedules até cancelar. */
export interface CalBooking {
  id: number;
  uid: string;
  eventTypeId: number;
  startTime: string;
  endTime: string;
  status: 'ACCEPTED' | 'PENDING' | 'CANCELLED' | 'REJECTED';
  attendees: Array<{
    email: string;
    name: string;
    timeZone?: string;
  }>;
  metadata?: Record<string, unknown>;
}

/** Input de createBooking — Cal.com aceita attendee mínimo + start/end. */
export interface CalCreateBookingInput {
  eventTypeId: number;
  start: string;
  attendee: {
    email: string;
    name: string;
    timeZone: string;
  };
  metadata?: Record<string, unknown>;
}

/** Webhook payload Cal.com self-host com discriminator triggerEvent. */
export type CalWebhookTrigger =
  | 'BOOKING_CREATED'
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_RESCHEDULED'
  | 'BOOKING_CANCELLED';

export interface CalWebhookPayload<T extends CalWebhookTrigger = CalWebhookTrigger> {
  triggerEvent: T;
  createdAt: string;
  payload: {
    uid: string;
    bookingId?: number;
    eventTypeId: number;
    startTime: string;
    endTime: string;
    status?: string;
    attendees: Array<{ email: string; name: string }>;
    rescheduleUid?: string;
    cancellationReason?: string;
    metadata?: Record<string, unknown>;
  };
}

/** Config injetada na CalcomClient (vem do clinic_integrations decryptado). */
export interface CalcomConfig {
  apiKey: string;
  baseUrl: string;
  defaultEventTypeId?: number;
}

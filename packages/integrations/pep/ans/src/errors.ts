/**
 * Typed errors mirror @medina/integrations-calcom/errors.ts pattern.
 *
 * Hierarchy:
 *   AnsApiError                 — base; status + body context
 *   AnsPatientNotFoundError     — 404 buscar-por-telefone
 *   AnsUnavailableError         — 429/5xx esgotou retries OU network/timeout
 *
 * TODO: validar contra ANS real — status codes podem diferir.
 */

export class AnsApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly body: unknown

  constructor(args: { status: number; body?: unknown; code?: string; message?: string }) {
    super(args.message ?? `ANS API error ${args.status}`)
    this.name = 'AnsApiError'
    this.status = args.status
    this.code = args.code
    this.body = args.body
  }
}

export class AnsPatientNotFoundError extends AnsApiError {
  constructor(telefone: string, body?: unknown) {
    super({ status: 404, body, message: `ANS patient not found for telefone=${telefone}` })
    this.name = 'AnsPatientNotFoundError'
  }
}

export class AnsUnavailableError extends Error {
  override readonly cause: unknown

  constructor(cause?: unknown) {
    const reason =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown'
    super(`ANS unavailable: ${reason}`)
    this.name = 'AnsUnavailableError'
    this.cause = cause
  }
}

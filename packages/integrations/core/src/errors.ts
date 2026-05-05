export class IntegrationNotFoundError extends Error {
  constructor(type: string, provider: string, clinicId: string) {
    super(`Integration not found: ${type}/${provider} for clinic ${clinicId}`)
    this.name = 'IntegrationNotFoundError'
  }
}

export class InvalidSignatureError extends Error {
  constructor() {
    super('Invalid webhook signature')
    this.name = 'InvalidSignatureError'
  }
}

export class AdapterNotRegisteredError extends Error {
  constructor(type: string, provider: string) {
    super(`No adapter registered for ${type}/${provider}`)
    this.name = 'AdapterNotRegisteredError'
  }
}

export class AdapterError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'AdapterError'
  }
}

export class InngestDispatchError extends Error {
  constructor(cause: unknown) {
    super('inngest dispatch failed', { cause })
    this.name = 'InngestDispatchError'
  }
}

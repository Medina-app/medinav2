import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import { handleWebhook } from '../src/webhook-handler'
import { registry } from '../src/registry'
import { InngestDispatchError } from '../src/errors'
import type { Logger, LogEntry } from '../src/logger'
import type { AdapterInterface, IntegrationType, WebhookContext } from '../src/types'
import type { ClinicIntegration } from '@medina/db'

// PR-E #11: makes assertions on structured log args possible without spying
// on console.log + JSON.parse. Test injects this mock via the loggerOverride
// param of handleWebhook.
function makeMockLogger(): { logger: Logger; calls: { level: 'info' | 'warn' | 'error'; entry: LogEntry }[] } {
  const calls: { level: 'info' | 'warn' | 'error'; entry: LogEntry }[] = []
  return {
    calls,
    logger: {
      info: (e) => { calls.push({ level: 'info', entry: e }) },
      warn: (e) => { calls.push({ level: 'warn', entry: e }) },
      error: (e) => { calls.push({ level: 'error', entry: e }) },
    },
  }
}

const sign = (s: string, b: string) => createHmac('sha256', s).update(b, 'utf8').digest('hex')
const SECRET = 'test-secret'
const PARAMS = { type: 'whatsapp', provider: 'kapso', clinicId: 'clinic-abc' }

function makeInt(ov: Partial<ClinicIntegration> = {}): ClinicIntegration {
  return {
    id: 'int-1',
    clinicId: 'clinic-abc',
    type: 'whatsapp',
    provider: 'kapso',
    name: 'T',
    status: 'active',
    config: {},
    webhookSecret: SECRET,
    webhookPath: '/api/webhooks/whatsapp/kapso/clinic-abc',
    encryptedCredentials: null,
    lastSyncAt: null,
    lastError: null,
    lastErrorAt: null,
    metadata: {},
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...ov,
  } as ClinicIntegration
}

function makeAdapter(ov: Partial<AdapterInterface> = {}): AdapterInterface {
  return {
    type: 'whatsapp' as IntegrationType,
    provider: 'kapso',
    signatureHeader: 'x-kapso-signature',
    handle: vi.fn().mockResolvedValue({ processed: true }),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    ...ov,
  }
}

const req = (body: string, hdrs: Record<string, string> = {}) =>
  new Request('http://localhost', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...hdrs },
  })

describe('handleWebhook', () => {
  afterEach(() => registry._clear())

  it('returns 404 when integration not found', async () => {
    const res = await handleWebhook(req('{}'), PARAMS, vi.fn().mockResolvedValue(null))
    expect(res.status).toBe(404)
  })

  it('returns 400 when integration is disabled', async () => {
    const res = await handleWebhook(
      req('{}'),
      PARAMS,
      vi.fn().mockResolvedValue(makeInt({ status: 'disabled' })),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when type/provider mismatch', async () => {
    const res = await handleWebhook(
      req('{}'),
      PARAMS,
      vi.fn().mockResolvedValue(makeInt({ type: 'pep', provider: 'iclinic' })),
    )
    expect(res.status).toBe(400)
  })

  it('returns 401 when HMAC signature is invalid', async () => {
    registry.register(makeAdapter())
    const res = await handleWebhook(
      req('{}', { 'x-kapso-signature': 'bad' }),
      PARAMS,
      vi.fn().mockResolvedValue(makeInt()),
    )
    expect(res.status).toBe(401)
  })

  it('returns 403 when integration is active but has no webhook secret', async () => {
    registry.register(makeAdapter())
    const res = await handleWebhook(
      req('{}'),
      PARAMS,
      vi.fn().mockResolvedValue(makeInt({ webhookSecret: null, status: 'active' })),
    )
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toBe('secret_not_configured')
  })

  it('returns 403 when integration is in error state but has no webhook secret', async () => {
    registry.register(makeAdapter())
    const res = await handleWebhook(
      req('{}'),
      PARAMS,
      vi.fn().mockResolvedValue(makeInt({ webhookSecret: null, status: 'error' })),
    )
    expect(res.status).toBe(403)
  })

  it('allows request without signature when integration is configuring', async () => {
    const body = '{}'
    const adapter = makeAdapter()
    registry.register(adapter)
    const res = await handleWebhook(
      req(body),
      PARAMS,
      vi.fn().mockResolvedValue(makeInt({ webhookSecret: null, status: 'configuring' })),
    )
    expect(res.status).toBe(200)
    expect(adapter.handle).toHaveBeenCalledOnce()
  })

  it('dispatches to correct adapter when signature is valid', async () => {
    const body = '{"event":"msg"}'
    const adapter = makeAdapter()
    registry.register(adapter)
    const res = await handleWebhook(
      req(body, { 'x-kapso-signature': sign(SECRET, body) }),
      PARAMS,
      vi.fn().mockResolvedValue(makeInt()),
    )
    expect(res.status).toBe(200)
    expect(adapter.handle).toHaveBeenCalledOnce()
    const ctx = (adapter.handle as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as WebhookContext
    expect(ctx.clinicId).toBe('clinic-abc')
    expect(ctx.rawBody).toBe(body)
  })

  it('returns 200 even if adapter throws (idempotência)', async () => {
    const body = '{}'
    registry.register(makeAdapter({ handle: vi.fn().mockRejectedValue(new Error('boom')) }))
    const res = await handleWebhook(
      req(body, { 'x-kapso-signature': sign(SECRET, body) }),
      PARAMS,
      vi.fn().mockResolvedValue(makeInt()),
    )
    expect(res.status).toBe(200)
    expect((await res.json() as { processed: boolean }).processed).toBe(false)
  })

  it('returns 503 when adapter throws InngestDispatchError (sender retries)', async () => {
    const body = '{}'
    registry.register(
      makeAdapter({
        handle: vi.fn().mockRejectedValue(new InngestDispatchError(new Error('upstream down'))),
      }),
    )
    const res = await handleWebhook(
      req(body, { 'x-kapso-signature': sign(SECRET, body) }),
      PARAMS,
      vi.fn().mockResolvedValue(makeInt()),
    )
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('inngest dispatch failed')
  })

  it('logs structured warn when InngestDispatchError surfaces (PR-E #11: injected Logger)', async () => {
    const body = '{}'
    registry.register(
      makeAdapter({
        handle: vi.fn().mockRejectedValue(new InngestDispatchError(new Error('upstream down'))),
      }),
    )
    const { logger, calls } = makeMockLogger()
    await handleWebhook(
      req(body, { 'x-kapso-signature': sign(SECRET, body) }),
      PARAMS,
      vi.fn().mockResolvedValue(makeInt()),
      undefined,
      undefined,
      logger,
    )
    const warnEntry = calls.find((c) => c.level === 'warn' && c.entry.action === 'inngest_dispatch')
    expect(warnEntry).toBeDefined()
    expect(warnEntry!.entry.success).toBe(false)
    expect(String(warnEntry!.entry.error)).toContain('inngest dispatch failed')
  })

  it('logs structured error when adapter throws (PR-E #11: injected Logger)', async () => {
    const body = '{}'
    registry.register(makeAdapter({ handle: vi.fn().mockRejectedValue(new Error('conn refused')) }))
    const { logger, calls } = makeMockLogger()
    await handleWebhook(
      req(body, { 'x-kapso-signature': sign(SECRET, body) }),
      PARAMS,
      vi.fn().mockResolvedValue(makeInt()),
      undefined,
      undefined,
      logger,
    )
    const errEntry = calls.find((c) => c.level === 'error')
    expect(errEntry).toBeDefined()
    expect(errEntry!.entry.success).toBe(false)
    expect(String(errEntry!.entry.error)).toContain('conn refused')
  })
})

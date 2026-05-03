import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import { handleWebhook } from '../src/webhook-handler.js'
import { registry } from '../src/registry.js'
import type { AdapterInterface, IntegrationType, WebhookContext } from '../src/types.js'
import type { ClinicIntegration } from '@medina/db'

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

  it('logs structured error when adapter throws', async () => {
    const body = '{}'
    registry.register(makeAdapter({ handle: vi.fn().mockRejectedValue(new Error('conn refused')) }))
    const spy = vi.spyOn(console, 'log')
    await handleWebhook(
      req(body, { 'x-kapso-signature': sign(SECRET, body) }),
      PARAMS,
      vi.fn().mockResolvedValue(makeInt()),
    )
    const entries = spy.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
    const errEntry = entries.find((e) => e['level'] === 'error')
    expect(errEntry?.['success']).toBe(false)
    expect(String(errEntry?.['error'])).toContain('conn refused')
  })
})

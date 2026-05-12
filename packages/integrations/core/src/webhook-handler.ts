import { createClient } from '@supabase/supabase-js'
import type { ClinicIntegration } from '@medina/db'
import { verifyHmacSignature } from './signature'
import { registry } from './registry'
import { logger, type Logger } from './logger'
import { mapClinicIntegration } from './mappers'
import { InngestDispatchError } from './errors'
import type { InngestSendFn, PublishEventFn, WebhookContext } from './types'

export type LookupFn = (
  type: string,
  provider: string,
  clinicId: string,
) => Promise<ClinicIntegration | null>

// PR-E #6+#14: module-level lazy singleton. The previous default param
// `lookupFn: LookupFn = createDefaultLookup()` was evaluated per call,
// instantiating a fresh Supabase client + connection pool on every webhook
// hit (post-chat-1 #3 + post-push B6 audits both flagged this). Memoize so
// the FIRST handleWebhook call lazily creates one client, subsequent calls
// reuse it.
//
// Lazy (vs eager top-level `const`) because env vars may not be set at
// module import time in some test/build paths; defer until first hit guarantees
// they're set by then.
let _defaultLookup: LookupFn | null = null

function getDefaultLookup(): LookupFn {
  if (_defaultLookup == null) {
    _defaultLookup = createDefaultLookupImpl()
  }
  return _defaultLookup
}

function createDefaultLookupImpl(): LookupFn {
  const sb = createClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
  return async (type, provider, clinicId) => {
    const { data } = await sb
      .from('clinic_integrations')
      .select('*')
      .eq('type', type)
      .eq('provider', provider)
      .eq('clinic_id', clinicId)
      .is('deleted_at', null)
      .single()
    // Supabase JS returns snake_case keys; map to camelCase ClinicIntegration
    // so handler + adapters can rely on the Drizzle type contract.
    return data ? mapClinicIntegration(data as Record<string, unknown>) : null
  }
}

const j = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export async function handleWebhook(
  req: Request,
  params: { type: string; provider: string; clinicId: string },
  lookupFn?: LookupFn,
  inngestSend?: InngestSendFn,
  publishEvent?: PublishEventFn,
  loggerOverride?: Logger,
): Promise<Response> {
  // PR-E #11: tests inject mock Logger here instead of spying on console.log.
  const log: Logger = loggerOverride ?? logger
  // PR-E #6+#14: lazy singleton — first call creates the Supabase client,
  // subsequent calls reuse it. Explicit lookupFn arg (e.g. test mock) bypasses.
  const lookup: LookupFn = lookupFn ?? getDefaultLookup()
  const t0 = Date.now()
  const { type, provider, clinicId } = params
  const base = { clinic_id: clinicId, integration_id: '', type, provider }

  const integration = await lookup(type, provider, clinicId)
  if (!integration) {
    log.warn({
      ...base,
      action: 'lookup',
      duration_ms: Date.now() - t0,
      success: false,
      error: 'integration_not_found',
    })
    return j({ error: 'not_found' }, 404)
  }
  const lb = { ...base, integration_id: integration.id }

  if (integration.status === 'disabled') {
    log.warn({
      ...lb,
      action: 'validate_status',
      duration_ms: Date.now() - t0,
      success: false,
      error: 'integration_disabled',
    })
    return j({ error: 'integration_disabled' }, 400)
  }

  if (integration.type !== type || integration.provider !== provider) {
    log.warn({
      ...lb,
      action: 'validate_type_provider',
      duration_ms: Date.now() - t0,
      success: false,
      error: 'type_provider_mismatch',
    })
    return j({ error: 'type_provider_mismatch' }, 400)
  }

  const adapter = registry.get(type, provider)
  const rawBody = await req.text()

  if (integration.status !== 'configuring') {
    if (!integration.webhookSecret) {
      log.warn({
        ...lb,
        action: 'validate_signature',
        duration_ms: Date.now() - t0,
        success: false,
        error: 'secret_not_configured',
      })
      return j({ error: 'secret_not_configured' }, 403)
    }
    const sig = req.headers.get(adapter.signatureHeader) ?? ''
    if (!verifyHmacSignature(integration.webhookSecret, rawBody, sig)) {
      log.warn({
        ...lb,
        action: 'validate_signature',
        duration_ms: Date.now() - t0,
        success: false,
        error: 'invalid_signature',
      })
      return j({ error: 'invalid_signature' }, 401)
    }
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    payload = rawBody
  }

  const ctx: WebhookContext = {
    clinicId,
    integration,
    payload,
    headers: Object.fromEntries(req.headers.entries()),
    rawBody,
    inngestSend,
    publishEvent,
  }

  try {
    const result = await adapter.handle(ctx)
    log.info({ ...lb, action: 'handle', duration_ms: Date.now() - t0, success: true })
    return j(result, 200)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (err instanceof InngestDispatchError) {
      // Surface a 5xx so the upstream sender (e.g. Kapso) retries the
      // delivery — otherwise a transient Inngest outage silently drops
      // status callbacks because we already 200'd the webhook.
      log.warn({
        ...lb,
        action: 'inngest_dispatch',
        duration_ms: Date.now() - t0,
        success: false,
        error,
      })
      return new Response('inngest dispatch failed', { status: 503 })
    }
    log.error({ ...lb, action: 'handle', duration_ms: Date.now() - t0, success: false, error })
    return j({ processed: false, reason: 'adapter_error' }, 200)
  }
}

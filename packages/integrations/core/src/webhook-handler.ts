import { createClient } from '@supabase/supabase-js'
import type { ClinicIntegration } from '@medina/db'
import { verifyHmacSignature } from './signature'
import { registry } from './registry'
import { logger } from './logger'
import { mapClinicIntegration } from './mappers'
import { InngestDispatchError } from './errors'
import type { InngestSendFn, WebhookContext } from './types'

export type LookupFn = (
  type: string,
  provider: string,
  clinicId: string,
) => Promise<ClinicIntegration | null>

function createDefaultLookup(): LookupFn {
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
  lookupFn: LookupFn = createDefaultLookup(),
  inngestSend?: InngestSendFn,
): Promise<Response> {
  const t0 = Date.now()
  const { type, provider, clinicId } = params
  const base = { clinic_id: clinicId, integration_id: '', type, provider }

  const integration = await lookupFn(type, provider, clinicId)
  if (!integration) {
    logger.warn({
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
    logger.warn({
      ...lb,
      action: 'validate_status',
      duration_ms: Date.now() - t0,
      success: false,
      error: 'integration_disabled',
    })
    return j({ error: 'integration_disabled' }, 400)
  }

  if (integration.type !== type || integration.provider !== provider) {
    logger.warn({
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
      logger.warn({
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
      logger.warn({
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
  }

  try {
    const result = await adapter.handle(ctx)
    logger.info({ ...lb, action: 'handle', duration_ms: Date.now() - t0, success: true })
    return j(result, 200)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (err instanceof InngestDispatchError) {
      // Surface a 5xx so the upstream sender (e.g. Kapso) retries the
      // delivery — otherwise a transient Inngest outage silently drops
      // status callbacks because we already 200'd the webhook.
      logger.warn({
        ...lb,
        action: 'inngest_dispatch',
        duration_ms: Date.now() - t0,
        success: false,
        error,
      })
      return new Response('inngest dispatch failed', { status: 503 })
    }
    logger.error({ ...lb, action: 'handle', duration_ms: Date.now() - t0, success: false, error })
    return j({ processed: false, reason: 'adapter_error' }, 200)
  }
}

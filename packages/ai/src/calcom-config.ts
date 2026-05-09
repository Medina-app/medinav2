/**
 * AI-4: lookup helper para credentials Cal.com da clinic.
 *
 * Lê clinic_integrations row (type='calcom', status='active') e decryptа
 * encrypted_credentials via RPC get_integration_credential_internal
 * (service_role only). Retorna null se integration ausente / disabled —
 * dispatcher deixa ToolContext.calcomClient undefined → tools Cal.com
 * retornam {ok:false, error:'calcom_not_configured'}.
 *
 * Schema esperado de encrypted_credentials JSONB:
 *   { api_key: string, base_url: string, default_event_type_id?: number }
 *
 * Reutilizado em dispatcher (AI flow) e potencialmente em server actions
 * de admin UI futuro.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CalcomClientLike } from './types.js'

export interface CalcomResolvedConfig {
  apiKey: string
  baseUrl: string
  defaultEventTypeId?: number
}

/**
 * Allowlist de hosts Cal.com aceitos. Defesa contra SSRF se a credential
 * encrypted_credentials.base_url for adulterada (insider threat ou key leak).
 *
 *   - cal.medina.app: instância self-host oficial (decisão Gabriel 2026-05-08)
 *   - api.cal.com:    Cal Cloud (fallback caso clínica use SaaS)
 *
 * Adicionar novos hosts requer revisão de segurança.
 */
const ALLOWED_CALCOM_HOSTS = new Set(['cal.medina.app', 'api.cal.com'])

function isValidCalcomBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return false
    return ALLOWED_CALCOM_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/**
 * Lookup integration row + decrypt credentials. Retorna null se:
 *   - Nenhuma row clinic_integrations type='calcom' active pra esta clinic
 *   - encrypted_credentials missing ou shape inválido
 *   - base_url falha allowlist (HTTPS + host conhecido)
 *
 * Throws se a query do Supabase falhar — não mascarar incidente operacional
 * como "integração ausente".
 */
export async function resolveCalcomConfig(
  supabase: SupabaseClient,
  clinicId: string,
): Promise<CalcomResolvedConfig | null> {
  const { data: integration, error: lookupErr } = await supabase
    .from('clinic_integrations')
    .select('id, status')
    .eq('clinic_id', clinicId)
    .eq('type', 'calcom')
    .eq('provider', 'calcom')
    .is('deleted_at', null)
    .maybeSingle()

  if (lookupErr) {
    throw new Error(
      `resolveCalcomConfig: clinic_integrations lookup failed for clinic ${clinicId}: ${lookupErr.message}`,
    )
  }

  if (!integration) return null
  const integ = integration as { id: string; status: string }
  if (integ.status !== 'active') return null

  // Decrypt via RPC. Retorna text JSON; parse manual.
  const { data: credText, error } = await supabase.rpc('get_integration_credential_internal', {
    p_integration_id: integ.id,
  })
  if (error) {
    throw new Error(
      `resolveCalcomConfig: decrypt failed for integration ${integ.id} (clinic ${clinicId}): ${error.message}`,
    )
  }
  if (typeof credText !== 'string') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(credText)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const apiKey = obj['api_key']
  const baseUrl = obj['base_url']
  if (typeof apiKey !== 'string' || typeof baseUrl !== 'string') return null
  // Fail-safe: api_key vazio/whitespace = credencial inválida. Sem essa
  // checagem, dispatcher constrói client e só falha em runtime na 1ª chamada
  // ao Cal.com — clínica parece "configurada" mas está quebrada.
  if (apiKey.trim().length === 0) return null
  if (!isValidCalcomBaseUrl(baseUrl)) return null

  const defaultEventTypeId =
    typeof obj['default_event_type_id'] === 'number'
      ? (obj['default_event_type_id'] as number)
      : undefined

  return { apiKey, baseUrl, defaultEventTypeId }
}

/**
 * Builder de CalcomClientLike a partir de config — abstraído pra testes
 * conseguirem injetar mocks. Em produção, dispatcher chama com factory que
 * importa CalcomClient de @medina/integrations-calcom.
 */
export type CalcomClientBuilder = (config: CalcomResolvedConfig) => CalcomClientLike

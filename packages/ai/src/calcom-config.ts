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
 * Lookup integration row + decrypt credentials. Retorna null se:
 *   - Nenhuma row clinic_integrations type='calcom' active pra esta clinic
 *   - encrypted_credentials missing ou shape inválido
 */
export async function resolveCalcomConfig(
  supabase: SupabaseClient,
  clinicId: string,
): Promise<CalcomResolvedConfig | null> {
  const { data: integration } = await supabase
    .from('clinic_integrations')
    .select('id, status')
    .eq('clinic_id', clinicId)
    .eq('type', 'calcom')
    .eq('provider', 'calcom')
    .is('deleted_at', null)
    .maybeSingle()

  if (!integration) return null
  const integ = integration as { id: string; status: string }
  if (integ.status !== 'active') return null

  // Decrypt via RPC. Retorna text JSON; parse manual.
  const { data: credText, error } = await supabase.rpc('get_integration_credential_internal', {
    p_integration_id: integ.id,
  })
  if (error || typeof credText !== 'string') return null

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

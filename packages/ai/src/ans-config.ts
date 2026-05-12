/**
 * M1a-2: lookup helper para credentials ANS PEP.
 *
 * Mednobre é o primeiro cliente (clinica_id=384, clinica_unidade_id=374).
 * Credenciais vêm de env vars (single-tenant pra M1a). Multi-tenant proper
 * via clinic_integrations.encrypted_credentials JSONB fica pra M1c (mirror
 * do pattern Cal.com).
 *
 * Schema env esperado:
 *   ANS_BASE_URL              — base URL da API ANS (TODO: validar)
 *   ANS_CLINICA_TOKEN         — token de autenticação por clinic
 *   ANS_CLINICA_ID            — id_clinica (int)
 *   ANS_CLINICA_UNIDADE_ID    — id_clinica_unidade (int)
 *
 * Retorna null se qualquer env var ausente — dispatcher deixa
 * ToolContext.ansClient undefined → tools PEP retornam {ok:false,
 * error:'pep_ans_not_configured'}.
 *
 * TODO M1c: migrar pra clinic_integrations (type='pep', provider='ans')
 * + encrypted_credentials via get_integration_credential_internal RPC.
 * Quando isso acontecer, esta função vira parametrizada por clinicId
 * (igual resolveCalcomConfig).
 */

export interface AnsResolvedConfig {
  baseUrl: string
  clinicaToken: string
  clinicaId: number
  clinicaUnidadeId: number
}

/**
 * Lê config ANS do environment. Retorna null se incompleto.
 *
 * Async pra match assinatura de resolveCalcomConfig — facilita futura
 * migração pra DB lookup sem mudar callsite no dispatcher.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function resolveAnsConfig(): Promise<AnsResolvedConfig | null> {
  const baseUrl = process.env['ANS_BASE_URL']
  const clinicaToken = process.env['ANS_CLINICA_TOKEN']
  const clinicaIdRaw = process.env['ANS_CLINICA_ID']
  const clinicaUnidadeIdRaw = process.env['ANS_CLINICA_UNIDADE_ID']

  if (!baseUrl || !clinicaToken || !clinicaIdRaw || !clinicaUnidadeIdRaw) return null

  const clinicaId = parseInt(clinicaIdRaw, 10)
  const clinicaUnidadeId = parseInt(clinicaUnidadeIdRaw, 10)
  if (!Number.isFinite(clinicaId) || !Number.isFinite(clinicaUnidadeId)) return null

  return {
    baseUrl: baseUrl.trim(),
    clinicaToken: clinicaToken.trim(),
    clinicaId,
    clinicaUnidadeId,
  }
}

/**
 * Builder de AnsClientLike a partir de config — abstraído pra testes
 * injetarem mocks. Em produção, dispatcher recebe via DispatchAgentArgs
 * com factory que importa AnsClient real de @medina/integrations-pep-ans.
 */
export type AnsClientBuilder = (
  config: AnsResolvedConfig,
) => import('./types.js').AnsClientLike

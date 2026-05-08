/**
 * @medina/integrations-pep-iclinic — placeholder.
 *
 * Adapter pra integração futura com iClinic (PEP — Prontuário Eletrônico do
 * Paciente). Atualmente vazio; package.json `exports` aponta pra cá pra
 * reservar a public surface.
 *
 * Implementação fica pra um PR futuro quando integração com iClinic for
 * priorizada (não está no roadmap AI-1..AI-6).
 */

export const ICLINIC_ADAPTER_VERSION = '0.0.1' as const

export interface IclinicAdapterPlaceholder {
  readonly version: typeof ICLINIC_ADAPTER_VERSION
}

export const placeholder: IclinicAdapterPlaceholder = {
  version: ICLINIC_ADAPTER_VERSION,
}

/**
 * M1a ANS PEP HTTP client. Mirrors @medina/integrations-calcom/CalcomClient
 * pattern (Bearer-style auth header + retry exponential + typed errors).
 *
 * ⚠️ Option D: endpoints + payload shapes são INFERIDOS por padrões comuns
 * de PEPs brasileiros. NÃO VALIDADO contra Mednobre real. Marcado com TODO
 * em cada ponto crítico. Quando smoke quebrar por shape inesperado, para
 * e ajusta aqui.
 *
 * Auth scheme inferido: header `X-Clinica-Token` + body fields
 * `clinica_id`/`clinica_unidade_id` em POST, ou query params em GET.
 * Brazilian PEP APIs (dr.consulta, MV, iClinic) frequentemente seguem
 * esse pattern — token autentica a clínica, ids identificam unidade.
 */
import { AnsApiError, AnsUnavailableError } from './errors.js'
import type { AnsAvailableDay, AnsPatient, AnsTimeSlot } from './types.js'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 500

interface AnsClientOpts {
  baseUrl: string
  clinicaToken: string
  clinicaId: number
  clinicaUnidadeId: number
  retryDelayMs?: number
  maxRetries?: number
  timeoutMs?: number
}

export class AnsClient {
  private readonly baseUrl: string
  private readonly clinicaToken: string
  private readonly clinicaId: number
  private readonly clinicaUnidadeId: number
  private readonly retryDelayMs: number
  private readonly maxRetries: number
  private readonly timeoutMs: number

  constructor(opts: AnsClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.clinicaToken = opts.clinicaToken
    this.clinicaId = opts.clinicaId
    this.clinicaUnidadeId = opts.clinicaUnidadeId
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * TODO: validar contra ANS real
   * - Endpoint path: `/pacientes/buscar-por-telefone` (inferido)
   * - Method: POST com JSON body (mais portátil que query param)
   * - Response shape: `{ paciente: { id_paciente, nome, cpf, telefone } | null }`
   * - 404 também pode significar "não encontrado" — coerced para null
   */
  async lookupPatientByPhone(phone: string): Promise<AnsPatient | null> {
    const url = `${this.baseUrl}/pacientes/buscar-por-telefone`
    let res: Response
    try {
      res = await this.requestWithRetry(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          telefone: phone,
          clinica_id: this.clinicaId,
          clinica_unidade_id: this.clinicaUnidadeId,
        }),
      })
    } catch (err) {
      // 404 = paciente não encontrado → null (coerce, não throw)
      if (err instanceof AnsApiError && err.status === 404) return null
      throw err
    }
    const json = (await res.json()) as {
      paciente?: {
        id_paciente?: string
        nome?: string
        cpf?: string | null
        telefone?: string | null
      } | null
    }
    if (json.paciente == null) return null
    const p = json.paciente
    if (!p.id_paciente || !p.nome) {
      throw new AnsApiError({
        status: res.status,
        body: json,
        message: 'ANS lookupPatientByPhone: missing id_paciente or nome — TODO validate shape',
      })
    }
    return {
      id: p.id_paciente,
      fullName: p.nome,
      cpf: p.cpf ?? null,
      phone: p.telefone ?? null,
    }
  }

  /**
   * TODO: validar contra ANS real
   * - Endpoint path: `/agenda/dias-disponiveis` (inferido)
   * - Method: GET com query params (caching-friendly)
   * - Params: medico_id, data_inicio, data_fim, clinica_id, clinica_unidade_id
   * - Response shape: `{ dias: [{ data: 'YYYY-MM-DD', qtd_slots?: number }] }`
   */
  async listAvailableDays(args: {
    doctorAnsId: string
    from: string // 'YYYY-MM-DD'
    to: string   // 'YYYY-MM-DD'
  }): Promise<AnsAvailableDay[]> {
    const params = new URLSearchParams({
      medico_id: args.doctorAnsId,
      data_inicio: args.from,
      data_fim: args.to,
      clinica_id: String(this.clinicaId),
      clinica_unidade_id: String(this.clinicaUnidadeId),
    })
    const url = `${this.baseUrl}/agenda/dias-disponiveis?${params.toString()}`
    const res = await this.requestWithRetry(url, { method: 'GET' })
    const json = (await res.json()) as {
      dias?: Array<{ data?: string; qtd_slots?: number }>
    }
    const dias = json.dias ?? []
    return dias
      .filter((d): d is { data: string; qtd_slots?: number } => typeof d.data === 'string')
      .map((d) => ({
        date: d.data,
        ...(typeof d.qtd_slots === 'number' ? { slotsCount: d.qtd_slots } : {}),
      }))
  }

  /**
   * TODO: validar contra ANS real
   * - Endpoint path: `/agenda/horarios-disponiveis` (inferido)
   * - Method: GET com query params
   * - Params: medico_id, data, clinica_id, clinica_unidade_id
   * - Response shape: `{ horarios: [{ hora_inicio, hora_fim, duracao_minutos? }] }`
   */
  async listAvailableHours(args: {
    doctorAnsId: string
    date: string // 'YYYY-MM-DD'
  }): Promise<AnsTimeSlot[]> {
    const params = new URLSearchParams({
      medico_id: args.doctorAnsId,
      data: args.date,
      clinica_id: String(this.clinicaId),
      clinica_unidade_id: String(this.clinicaUnidadeId),
    })
    const url = `${this.baseUrl}/agenda/horarios-disponiveis?${params.toString()}`
    const res = await this.requestWithRetry(url, { method: 'GET' })
    const json = (await res.json()) as {
      horarios?: Array<{ hora_inicio?: string; hora_fim?: string; duracao_minutos?: number }>
    }
    const horarios = json.horarios ?? []
    return horarios
      .filter(
        (h): h is { hora_inicio: string; hora_fim: string; duracao_minutos?: number } =>
          typeof h.hora_inicio === 'string' && typeof h.hora_fim === 'string',
      )
      .map((h) => ({
        startTime: h.hora_inicio,
        endTime: h.hora_fim,
        ...(typeof h.duracao_minutos === 'number' ? { durationMinutes: h.duracao_minutos } : {}),
      }))
  }

  // ─── private ────────────────────────────────────────────────────────────────

  private async requestWithRetry(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      'X-Clinica-Token': this.clinicaToken,
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    }

    let lastErr: unknown = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchWithTimeout(url, { ...init, headers })
        // Retry-eligible: 429 + 5xx
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          if (attempt < this.maxRetries) {
            await this.sleep(this.retryDelayMs * Math.pow(2, attempt))
            continue
          }
          const body = await this.safeJson(res)
          throw new AnsUnavailableError(
            new AnsApiError({ status: res.status, body, message: `retries exhausted` }),
          )
        }
        if (!res.ok) {
          const body = await this.safeJson(res)
          // TODO: ANS error envelope shape unknown — try common patterns
          const code = ((body as { error?: { code?: string } })?.error?.code ??
            (body as { erro?: string })?.erro) ?? undefined
          throw new AnsApiError({ status: res.status, code, body })
        }
        return res
      } catch (err) {
        lastErr = err
        // Errors already typed — no retry, propagate.
        if (err instanceof AnsApiError || err instanceof AnsUnavailableError) {
          throw err
        }
        // Network/timeout — retry if budget remains.
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryDelayMs * Math.pow(2, attempt))
          continue
        }
        throw new AnsUnavailableError(err)
      }
    }
    throw new AnsUnavailableError(lastErr)
  }

  private async safeJson(res: Response): Promise<unknown> {
    try {
      return await res.json()
    } catch {
      return null
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

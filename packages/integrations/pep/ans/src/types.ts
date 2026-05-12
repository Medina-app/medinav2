/**
 * ANS API request/response types.
 *
 * ⚠️ Option D: shapes ABAIXO são INFERIDOS por padrões comuns de PEPs
 * brasileiros (similar a dr.consulta, iClinic, MV). NÃO VALIDADO contra
 * Mednobre real ainda. Quando o smoke quebrar por shape inesperado, para
 * e reporta o raw response — ajustamos types + client.parse aqui.
 *
 * TODO: validar contra ANS real:
 * - field names (camelCase vs snake_case vs PT-BR como "telefone"/"nome")
 * - date format ('YYYY-MM-DD' vs 'DD/MM/YYYY')
 * - hour format ('HH:mm' vs 'HH:mm:ss' vs ISO)
 * - error envelope ({ error: {...} } vs { erro: '...' } vs HTTP status only)
 */

// ─── Patient ──────────────────────────────────────────────────────────────────
export interface AnsPatient {
  /** ANS internal id_paciente. */
  id: string
  /** Nome completo do paciente. */
  fullName: string
  /** CPF se cadastrado; raramente disponível em primeira interação. */
  cpf: string | null
  /** Telefone normalizado (DDI + DDD + numero). */
  phone: string | null
}

// ─── Availability ─────────────────────────────────────────────────────────────
export interface AnsAvailableDay {
  /** Data ISO YYYY-MM-DD. */
  date: string
  /** Opcional: quantidade de slots livres (UI hint). */
  slotsCount?: number
}

export interface AnsTimeSlot {
  /** Hora início HH:mm 24h. */
  startTime: string
  /** Hora fim HH:mm 24h (= start + duracao_minutos). */
  endTime: string
  /** Duração em minutos (informativa; redundante com end-start). */
  durationMinutes?: number
}

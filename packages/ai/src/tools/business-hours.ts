import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import { addDays } from 'date-fns'
import type { ToolContext } from '../types.js'
import type { BusinessHours, DayOfWeek, DayHours } from '@medina/db'

const DEFAULT_HOURS: BusinessHours = {
  timezone: 'America/Sao_Paulo',
  schedule: {
    monday: { open: '08:00', close: '18:00' },
    tuesday: { open: '08:00', close: '18:00' },
    wednesday: { open: '08:00', close: '18:00' },
    thursday: { open: '08:00', close: '18:00' },
    friday: { open: '08:00', close: '18:00' },
    saturday: null,
    sunday: null,
  },
}

// Indexed by ISO day-of-week (1=Mon..7=Sun) — date-fns format token 'i'.
const DAY_BY_ISO: Record<number, DayOfWeek> = {
  1: 'monday',
  2: 'tuesday',
  3: 'wednesday',
  4: 'thursday',
  5: 'friday',
  6: 'saturday',
  7: 'sunday',
}

interface ClinicRow { id: string; business_hours: BusinessHours | null }
interface CheckResult {
  is_open: boolean
  next_open: string
  current_period: 'morning' | 'afternoon' | 'closed'
  timezone: string
}

export function buildBusinessHoursTool(ctx: ToolContext) {
  return createTool({
    id: 'check_business_hours',
    description:
      'Verifica se a clínica está aberta agora e retorna próximo horário de abertura. Use antes de propor agendamento imediato pra evitar prometer disponibilidade fora do expediente.',
    inputSchema: z.object({}),
    execute: async (): Promise<CheckResult> => {
      const { supabase, clinicId } = ctx

      const { data: clinicData, error } = await supabase
        .from('clinics')
        .select('business_hours, id')
        .eq('id', clinicId)
        .single()
      if (error || !clinicData) {
        throw new Error(`business_hours: clinic lookup failed: ${error?.message ?? 'not found'}`)
      }
      const clinic = clinicData as ClinicRow
      if (clinic.id !== clinicId) {
        throw new Error('business_hours: cross-tenant violation')
      }

      const hours: BusinessHours = clinic.business_hours ?? DEFAULT_HOURS
      const tz = hours.timezone

      const now = new Date()
      const isoDow = parseInt(formatInTimeZone(now, tz, 'i'), 10)
      const dayKey = DAY_BY_ISO[isoDow]
      const today: DayHours | null = dayKey != null ? hours.schedule[dayKey] : null
      const localHHMM = formatInTimeZone(now, tz, 'HH:mm')

      let isOpen = false
      let currentPeriod: CheckResult['current_period'] = 'closed'
      if (today) {
        if (localHHMM >= today.open && localHHMM < today.close) {
          isOpen = true
          const localHour = parseInt(localHHMM.slice(0, 2), 10)
          currentPeriod = localHour < 12 ? 'morning' : 'afternoon'
        }
      }

      const nextOpen = computeNextOpen(now, hours)
      return { is_open: isOpen, next_open: nextOpen, current_period: currentPeriod, timezone: tz }
    },
  })
}

function computeNextOpen(now: Date, hours: BusinessHours): string {
  const tz = hours.timezone
  for (let i = 0; i < 8; i++) {
    const candidate = addDays(now, i)
    const isoDow = parseInt(formatInTimeZone(candidate, tz, 'i'), 10)
    const dayKey = DAY_BY_ISO[isoDow]
    if (dayKey == null) continue
    const day: DayHours | null = hours.schedule[dayKey]
    if (!day) continue

    // Build the local datetime "YYYY-MM-DD HH:mm:00" in the target tz, convert to UTC.
    const localYmd = formatInTimeZone(candidate, tz, 'yyyy-MM-dd')
    const localOpenStr = `${localYmd} ${day.open}:00`
    const utcDate = fromZonedTime(localOpenStr, tz)
    if (utcDate > now) return utcDate.toISOString()
  }
  throw new Error('business_hours: no open day found in next 8 days — check schedule config')
}

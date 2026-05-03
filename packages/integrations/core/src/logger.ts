type Level = 'info' | 'warn' | 'error'

export type LogEntry = {
  clinic_id: string
  integration_id: string
  type: string
  provider: string
  action: string
  duration_ms: number
  success: boolean
  error?: string
}

const log = (level: Level, e: LogEntry) =>
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, ...e }))

export const logger = {
  info: (e: LogEntry) => log('info', e),
  warn: (e: LogEntry) => log('warn', e),
  error: (e: LogEntry) => log('error', e),
}

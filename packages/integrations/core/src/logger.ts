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

export interface Logger {
  info: (e: LogEntry) => void
  warn: (e: LogEntry) => void
  error: (e: LogEntry) => void
}

// PR-E #11: stdout-serialized logger is the default; tests inject a mock
// Logger via handleWebhook(..., loggerOverride) and assert on structured
// call args instead of spying on console.log + JSON.parse.
const stdoutLog = (level: Level, e: LogEntry) =>
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, ...e }))

export const logger: Logger = {
  info: (e) => stdoutLog('info', e),
  warn: (e) => stdoutLog('warn', e),
  error: (e) => stdoutLog('error', e),
}

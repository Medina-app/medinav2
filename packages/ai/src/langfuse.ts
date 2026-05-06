import { Langfuse } from 'langfuse'

let _client: Langfuse | null | undefined

/**
 * Returns a singleton Langfuse client, or null when env keys are missing.
 * Memoized — first call decides; subsequent calls return the same instance.
 *
 * Why memoize: the Langfuse SDK opens a background flusher; constructing
 * one per dispatcher invocation would leak timers in long-running workers.
 */
export function getLangfuseClient(): Langfuse | null {
  if (_client !== undefined) return _client
  const publicKey = process.env['LANGFUSE_PUBLIC_KEY']
  const secretKey = process.env['LANGFUSE_SECRET_KEY']
  const baseUrl = process.env['LANGFUSE_HOST']
  if (!publicKey || !secretKey) {
    _client = null
    return null
  }
  _client = new Langfuse({ publicKey, secretKey, baseUrl })
  return _client
}

/**
 * Test-only: reset the memoized client. Not exported from index.ts.
 * @internal
 */
export function _resetLangfuseClient(): void {
  _client = undefined
}

export interface TraceArgs {
  name: string
  sessionId: string
  userId?: string
  metadata?: Record<string, unknown>
}

// Trace shape — opaque to callers but typed enough for the methods we use.
// We don't depend on Langfuse's internal trace type so a SDK upgrade with
// API changes still type-checks; we just protect each call with try/catch.
export interface LangfuseTrace {
  id?: string
  update?: (args: Record<string, unknown>) => void
  generation?: (args: Record<string, unknown>) => unknown
  score?: (args: Record<string, unknown>) => void
}

/**
 * Wraps fn with optional Langfuse tracing. Failsafe by design:
 * - If client is null (no keys), runs fn unwrapped.
 * - If trace creation throws (langfuse offline), runs fn anyway.
 * - If trace.update / flushAsync throws, swallows the error.
 * - Errors thrown by fn itself ARE propagated — that's a real failure
 *   the caller (Inngest worker) needs to see for retry logic.
 */
export async function withTrace<T>(
  client: Langfuse | null,
  args: TraceArgs,
  fn: (trace: LangfuseTrace | null) => Promise<T>,
): Promise<T> {
  if (!client) return fn(null)

  let trace: LangfuseTrace | null = null
  try {
    // Cast through unknown — the real Langfuse trace has stricter method
    // signatures than our permissive structural interface, but we wrap each
    // call in try/catch so the looser shape is intentional.
    trace = client.trace({
      name: args.name,
      sessionId: args.sessionId,
      userId: args.userId,
      metadata: args.metadata,
    }) as unknown as LangfuseTrace
  } catch (err) {
    console.warn('langfuse trace creation failed', err)
  }

  try {
    return await fn(trace)
  } finally {
    try {
      trace?.update?.({ output: '<<see observations>>' })
    } catch {
      /* swallow */
    }
    try {
      await client.flushAsync()
    } catch {
      /* swallow */
    }
  }
}

/**
 * Records a numeric score on the given trace, swallowing any error.
 * Used for things like total dispatch latency — best-effort observability.
 */
export function scoreLatency(trace: LangfuseTrace | null, ms: number): void {
  try {
    trace?.score?.({ name: 'latency_ms', value: ms })
  } catch {
    /* swallow */
  }
}

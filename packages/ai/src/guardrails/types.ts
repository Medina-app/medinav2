/**
 * AI-5 Guardrails — shared types for pre-filter, urgency detector,
 * post-filter, and dispatcher integration.
 *
 * GuardrailsConfig is what agent_configs.guardrails (jsonb) deserializes to.
 * Empty object `{}` means "use TS defaults as-is" — no overrides, no opt-outs.
 */

/** Structured category persisted in conversations.escalated_reason. */
export type EscalatedReason =
  | 'medication'
  | 'diagnosis'
  | 'urgency'
  | 'symptom'
  | 'other'

/** Per-clinic override of TS defaults. All fields optional; empty == defaults. */
export interface GuardrailsConfig {
  /** Add patterns under existing or new category. Strings compile as RegExp(p, 'i'). */
  additional_blocked_patterns?: Record<string, string[]>
  /** Add patterns under existing or new urgency category. */
  additional_urgent_patterns?: Record<string, string[]>
  /** Categories to opt out of defaults (e.g. ['diagnostic_advice']). */
  disabled_default_categories?: string[]
}

/** Result of pre-filter on a single inbound message. Discriminated union. */
export type PreFilterMatch =
  | { matched: false }
  | {
      matched: true
      /** Pattern category id from defaults or override (e.g. 'medication_request'). */
      category: string
      /** Mapped EscalatedReason for conversations.escalated_reason. */
      reason: EscalatedReason
      /** The substring of the message that matched the regex. */
      evidence: string
    }

/** Result of urgency detector. Layered: regex → llm → fallback. */
export interface UrgencyResult {
  level: 'low' | 'medium' | 'critical'
  /** Present when level=critical (regex or llm classified). */
  category?: string
  /** Substring or short LLM justification. */
  evidence?: string
  /** Where the verdict came from. fallback = LLM error/timeout, defaulted medium. */
  source: 'regex' | 'llm' | 'fallback'
}

/** Result of post-filter on LLM-generated text. */
export interface OutputValidation {
  valid: boolean
  violation?: { category: string; evidence: string }
}

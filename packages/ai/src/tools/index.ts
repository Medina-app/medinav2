import type { ToolContext } from '../types.js'

export type ToolRecord = Record<string, unknown>

function requireClinicId(ctx: ToolContext): void {
  if (!ctx.clinicId) {
    throw new Error('clinicId is required in ToolContext')
  }
}

type ToolFactory = (ctx: ToolContext) => unknown

const search_kb: ToolFactory = (_ctx) => ({
  description: 'Search the clinic knowledge base for relevant information',
  execute: async (_args: unknown) => {
    throw new Error('search_kb: not yet implemented — wired in livechat sprint')
  },
})

const escalate_to_human: ToolFactory = (_ctx) => ({
  description: 'Escalate the conversation to a human agent',
  execute: async (_args: unknown) => {
    throw new Error('escalate_to_human: not yet implemented — wired in livechat sprint')
  },
})

const confirm_appointment: ToolFactory = (_ctx) => ({
  description: 'Confirm an appointment for the patient',
  execute: async (_args: unknown) => {
    throw new Error('confirm_appointment: not yet implemented — wired in livechat sprint')
  },
})

const CONDITIONAL_TOOLS: Record<string, ToolFactory> = {
  confirm_appointment,
}

export function buildBaseTools(ctx: ToolContext): ToolRecord {
  requireClinicId(ctx)
  return {
    search_kb: search_kb(ctx),
    escalate_to_human: escalate_to_human(ctx),
  }
}

export function buildConditionalTools(ctx: ToolContext, toolNames: string[]): ToolRecord {
  requireClinicId(ctx)
  const result: ToolRecord = {}
  for (const name of toolNames) {
    const factory = CONDITIONAL_TOOLS[name]
    if (factory) {
      result[name] = factory(ctx)
    }
  }
  return result
}

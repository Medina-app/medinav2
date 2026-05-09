import type { ToolContext } from '../types.js'
import { buildEscalateTool } from './escalate.js'
import { buildCollectInfoTool } from './collect-info.js'
import { buildBusinessHoursTool } from './business-hours.js'
import { buildSearchKbTool } from './search-kb.js'
import { buildCheckAvailabilityTool } from './check-availability.js'
import { buildConfirmAppointmentTool } from './confirm-appointment.js'
import { buildCancelAppointmentTool } from './cancel-appointment.js'
import { buildRescheduleAppointmentTool } from './reschedule-appointment.js'

type ToolBuilder = (ctx: ToolContext) => unknown

const REGISTRY: Record<string, ToolBuilder> = {
  escalate_to_human: buildEscalateTool,
  collect_patient_info: buildCollectInfoTool,
  check_business_hours: buildBusinessHoursTool,
  search_kb: buildSearchKbTool,
  // AI-4: tools Cal.com — só funcionam quando ToolContext.calcomClient
  // está injetado (ver agent-factory.ts wiring). Sem client ativo, tools
  // retornam {ok:false, error:'calcom_not_configured'}.
  check_availability: buildCheckAvailabilityTool,
  confirm_appointment: buildConfirmAppointmentTool,
  cancel_appointment: buildCancelAppointmentTool,
  reschedule_appointment: buildRescheduleAppointmentTool,
}

/**
 * Maps tool names from agent_config.tools[] (jsonb string array) to actual
 * Mastra tool instances bound to the dispatch context. Unknown names are
 * warned-about (not thrown) so a config-side typo doesn't crash a dispatch.
 */
export function buildToolsFromConfig(
  ctx: ToolContext,
  toolNames: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const name of toolNames) {
    const builder = REGISTRY[name]
    if (!builder) {
      console.warn(`buildToolsFromConfig: unknown tool: ${name} — ignoring`)
      continue
    }
    out[name] = builder(ctx)
  }
  return out
}

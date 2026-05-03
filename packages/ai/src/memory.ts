import { buildResourceId, buildThreadId } from './namespacing.js'
import { NamespacingViolationError } from './errors.js'

export interface MemoryArgs {
  resourceId: string
  threadId: string
}

export function validateAndBuildMemoryArgs(
  clinicId: string,
  patientId: string,
  conversationId: string
): MemoryArgs {
  if (!clinicId) {
    throw new NamespacingViolationError('clinicId must not be empty')
  }
  if (!patientId) {
    throw new NamespacingViolationError('patientId must not be empty')
  }
  if (!conversationId) {
    throw new NamespacingViolationError('conversationId must not be empty')
  }
  const resourceId = buildResourceId(clinicId, 'patient', patientId)
  const threadId = buildThreadId(clinicId, conversationId)
  return { resourceId, threadId }
}

// createClinicMemory uses @mastra/pg PostgresStore.
// Not unit-tested here (requires live Postgres). Called by the livechat integration layer.
export async function createClinicMemory(connectionString: string) {
  const { PostgresStore } = await import('@mastra/pg')
  return new PostgresStore({ connectionString })
}

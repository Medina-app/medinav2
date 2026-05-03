import { NamespacingViolationError } from './errors.js'

export function buildResourceId(
  clinicId: string,
  type: 'patient' | 'thread',
  id: string
): string {
  return `clinic:${clinicId}:${type}:${id}`
}

export function buildThreadId(clinicId: string, conversationId: string): string {
  return `clinic:${clinicId}:conv:${conversationId}`
}

export function parseResourceId(rid: string): {
  clinicId: string
  type: string
  id: string
} {
  if (!rid) {
    throw new NamespacingViolationError(`Malformed resourceId: "${rid}"`)
  }
  const parts = rid.split(':')
  // noUncheckedIndexedAccess: array elements are string | undefined
  const prefix = parts[0]
  const clinicId = parts[1] ?? ''
  const type = parts[2] ?? ''
  const id = parts.slice(3).join(':')

  if (parts.length < 4 || prefix !== 'clinic' || !clinicId || !type || !id) {
    throw new NamespacingViolationError(`Malformed resourceId: "${rid}"`)
  }
  return { clinicId, type, id }
}

export function assertResourceIdMatchesClinic(
  rid: string,
  expectedClinicId: string
): void {
  const { clinicId } = parseResourceId(rid)
  if (clinicId !== expectedClinicId) {
    throw new NamespacingViolationError(
      `Cross-tenant access: resourceId clinicId "${clinicId}" does not match expected "${expectedClinicId}"`
    )
  }
}

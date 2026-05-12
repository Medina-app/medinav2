/**
 * AnsAdapter — thin facade exposing only the 3 methods consumed by AI tools.
 *
 * Kept distinct from `AnsClient` so:
 * - Future M1b can add a SAGA layer (createBooking with rollback) without
 *   bloating the adapter interface — adapter stays read-only.
 * - Tests inject mocked adapters into tools without needing to construct
 *   a full client (no fetch mocking required at the tool layer).
 *
 * Mirror pattern: `@medina/integrations-calcom` exposes adapter from
 * `CalcomClient` similarly.
 */
import type { AnsClient } from './client.js'

export interface AnsAdapter {
  lookupPatientByPhone: AnsClient['lookupPatientByPhone']
  listAvailableDays: AnsClient['listAvailableDays']
  listAvailableHours: AnsClient['listAvailableHours']
}

export function makeAnsAdapter(client: AnsClient): AnsAdapter {
  return {
    lookupPatientByPhone: (phone) => client.lookupPatientByPhone(phone),
    listAvailableDays: (args) => client.listAvailableDays(args),
    listAvailableHours: (args) => client.listAvailableHours(args),
  }
}

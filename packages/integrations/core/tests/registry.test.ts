import { describe, it, expect, afterEach } from 'vitest'
import { registry } from '../src/registry.js'
import { AdapterNotRegisteredError } from '../src/errors.js'
import type { AdapterInterface, IntegrationType } from '../src/types.js'
import type { ClinicIntegration } from '@medina/db'

const stub = (type: IntegrationType, provider: string): AdapterInterface => ({
  type,
  provider,
  signatureHeader: 'x-sig',
  handle: async () => ({ processed: false }),
  healthCheck: async (_i: ClinicIntegration) => ({ healthy: false }),
})

describe('registry', () => {
  afterEach(() => registry._clear())

  it('registers and retrieves by type+provider', () => {
    registry.register(stub('whatsapp', 'kapso'))
    expect(registry.get('whatsapp', 'kapso').provider).toBe('kapso')
  })

  it('throws AdapterNotRegisteredError for unknown key', () =>
    expect(() => registry.get('calcom', 'calcom')).toThrow(AdapterNotRegisteredError))

  it('list returns all registered adapters', () => {
    registry.register(stub('whatsapp', 'kapso'))
    registry.register(stub('calcom', 'calcom'))
    expect(registry.list()).toHaveLength(2)
  })

  it('register overwrites same type+provider', () => {
    registry.register(stub('whatsapp', 'kapso'))
    const second = stub('whatsapp', 'kapso')
    registry.register(second)
    expect(registry.get('whatsapp', 'kapso')).toBe(second)
  })
})

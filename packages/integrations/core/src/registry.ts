import { AdapterNotRegisteredError } from './errors.js'
import type { AdapterInterface } from './types.js'

const adapters = new Map<string, AdapterInterface>()
const key = (t: string, p: string) => `${t}/${p}`

export const registry = {
  register(a: AdapterInterface): void {
    adapters.set(key(a.type, a.provider), a)
  },
  get(type: string, provider: string): AdapterInterface {
    const a = adapters.get(key(type, provider))
    if (!a) throw new AdapterNotRegisteredError(type, provider)
    return a
  },
  list(): AdapterInterface[] {
    return Array.from(adapters.values())
  },
  _clear(): void {
    adapters.clear()
  },
}

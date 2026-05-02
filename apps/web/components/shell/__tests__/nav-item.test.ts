import { describe, it, expect } from 'vitest'
import { isNavActive } from '../nav-item'

describe('isNavActive', () => {
  it('exact=true: matches only the exact path', () => {
    expect(isNavActive('/sao-lucas', '/sao-lucas', true)).toBe(true)
    expect(isNavActive('/sao-lucas/inbox', '/sao-lucas', true)).toBe(false)
  })

  it('exact=false: matches exact or prefix with trailing slash', () => {
    expect(isNavActive('/sao-lucas/inbox', '/sao-lucas/inbox', false)).toBe(true)
    expect(isNavActive('/sao-lucas/inbox/123', '/sao-lucas/inbox', false)).toBe(true)
    expect(isNavActive('/sao-lucas/pipeline', '/sao-lucas/inbox', false)).toBe(false)
  })

  it('never marks a sibling route as active', () => {
    expect(isNavActive('/sao-lucas/patients', '/sao-lucas/pipeline', false)).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import { verifyHmacSignature } from '../src/signature'

const sign = (s: string, p: string) => createHmac('sha256', s).update(p, 'utf8').digest('hex')

describe('verifyHmacSignature', () => {
  it('returns true for valid signature', () =>
    expect(verifyHmacSignature('s', 'p', sign('s', 'p'))).toBe(true))

  it('returns true with sha256= prefix', () =>
    expect(verifyHmacSignature('s', 'p', `sha256=${sign('s', 'p')}`)).toBe(true))

  it('returns false for tampered payload', () =>
    expect(verifyHmacSignature('s', 'tampered', sign('s', 'original'))).toBe(false))

  it('returns false for wrong secret', () =>
    expect(verifyHmacSignature('correct', 'p', sign('wrong', 'p'))).toBe(false))

  it('returns false for empty signature', () =>
    expect(verifyHmacSignature('s', '{}', '')).toBe(false))
})

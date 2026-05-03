import { describe, expect, it } from 'vitest'
import {
  assertResourceIdMatchesClinic,
  buildResourceId,
  buildThreadId,
  parseResourceId,
} from '../src/namespacing.js'
import { NamespacingViolationError } from '../src/errors.js'

describe('buildResourceId', () => {
  it('returns clinic:X:patient:Y format', () => {
    expect(buildResourceId('clinic-123', 'patient', 'pat-456')).toBe(
      'clinic:clinic-123:patient:pat-456'
    )
  })

  it('returns clinic:X:thread:Y format', () => {
    expect(buildResourceId('clinic-123', 'thread', 'thr-789')).toBe(
      'clinic:clinic-123:thread:thr-789'
    )
  })
})

describe('buildThreadId', () => {
  it('returns clinic:X:conv:Y format', () => {
    expect(buildThreadId('clinic-123', 'conv-789')).toBe(
      'clinic:clinic-123:conv:conv-789'
    )
  })
})

describe('parseResourceId', () => {
  it('parses valid patient resource id', () => {
    const rid = buildResourceId('clinic-abc', 'patient', 'pat-xyz')
    const parsed = parseResourceId(rid)
    expect(parsed.clinicId).toBe('clinic-abc')
    expect(parsed.type).toBe('patient')
    expect(parsed.id).toBe('pat-xyz')
  })

  it('rejects malformed string with too few segments', () => {
    expect(() => parseResourceId('invalid')).toThrow(NamespacingViolationError)
  })

  it('rejects string missing clinic prefix', () => {
    expect(() => parseResourceId('patient:clinic-abc:pat-1')).toThrow(
      NamespacingViolationError
    )
  })

  it('rejects empty string', () => {
    expect(() => parseResourceId('')).toThrow(NamespacingViolationError)
  })
})

describe('assertResourceIdMatchesClinic', () => {
  it('does not throw when clinicId matches', () => {
    const rid = buildResourceId('clinic-A', 'patient', 'pat-1')
    expect(() => assertResourceIdMatchesClinic(rid, 'clinic-A')).not.toThrow()
  })

  it('throws NamespacingViolationError on cross-tenant attempt', () => {
    const rid = buildResourceId('clinic-A', 'patient', 'pat-1')
    expect(() => assertResourceIdMatchesClinic(rid, 'clinic-B')).toThrow(
      NamespacingViolationError
    )
  })

  it('cross-tenant error message includes both clinic ids', () => {
    const rid = buildResourceId('clinic-A', 'patient', 'pat-1')
    try {
      assertResourceIdMatchesClinic(rid, 'clinic-B')
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(NamespacingViolationError)
      expect((e as Error).message).toContain('clinic-A')
      expect((e as Error).message).toContain('clinic-B')
    }
  })
})

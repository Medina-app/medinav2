import { describe, expect, it } from 'vitest'
import { validateAndBuildMemoryArgs } from '../src/memory.js'
import { NamespacingViolationError } from '../src/errors.js'

describe('validateAndBuildMemoryArgs', () => {
  it('builds correct resourceId for patient memory', () => {
    const args = validateAndBuildMemoryArgs('clinic-1', 'pat-1', 'conv-1')
    expect(args.resourceId).toBe('clinic:clinic-1:patient:pat-1')
  })

  it('builds correct threadId for conversation', () => {
    const args = validateAndBuildMemoryArgs('clinic-1', 'pat-1', 'conv-1')
    expect(args.threadId).toBe('clinic:clinic-1:conv:conv-1')
  })

  it('two clinics with same patientId have isolated resourceIds', () => {
    const a = validateAndBuildMemoryArgs('clinic-A', 'same-patient', 'conv-1')
    const b = validateAndBuildMemoryArgs('clinic-B', 'same-patient', 'conv-1')
    expect(a.resourceId).not.toBe(b.resourceId)
    expect(a.resourceId).toContain('clinic-A')
    expect(b.resourceId).toContain('clinic-B')
  })

  it('two conversations have isolated threadIds', () => {
    const a = validateAndBuildMemoryArgs('clinic-1', 'pat-1', 'conv-A')
    const b = validateAndBuildMemoryArgs('clinic-1', 'pat-1', 'conv-B')
    expect(a.threadId).not.toBe(b.threadId)
  })

  it('throws NamespacingViolationError when clinicId is empty string', () => {
    expect(() => validateAndBuildMemoryArgs('', 'pat-1', 'conv-1')).toThrow(
      NamespacingViolationError
    )
  })

  it('throws NamespacingViolationError when patientId is empty string', () => {
    expect(() => validateAndBuildMemoryArgs('clinic-1', '', 'conv-1')).toThrow(
      NamespacingViolationError
    )
  })

  it('throws NamespacingViolationError when conversationId is empty string', () => {
    expect(() => validateAndBuildMemoryArgs('clinic-1', 'pat-1', '')).toThrow(
      NamespacingViolationError
    )
  })
})

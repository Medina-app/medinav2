import { describe, expect, it } from 'vitest'
import { buildBaseTools, buildConditionalTools } from '../src/tools/index.js'
import type { ToolContext } from '../src/types.js'

describe('buildBaseTools', () => {
  it('returns an object with search_kb tool', () => {
    const ctx: ToolContext = { clinicId: 'clinic-1' }
    const tools = buildBaseTools(ctx)
    expect(tools).toHaveProperty('search_kb')
  })

  it('returns an object with escalate_to_human tool', () => {
    const ctx: ToolContext = { clinicId: 'clinic-1' }
    const tools = buildBaseTools(ctx)
    expect(tools).toHaveProperty('escalate_to_human')
  })

  it('throws when ctx.clinicId is empty string', () => {
    const ctx: ToolContext = { clinicId: '' }
    expect(() => buildBaseTools(ctx)).toThrow('clinicId is required')
  })
})

describe('buildConditionalTools', () => {
  it('returns empty object when toolNames array is empty', () => {
    const ctx: ToolContext = { clinicId: 'clinic-1' }
    const tools = buildConditionalTools(ctx, [])
    expect(Object.keys(tools)).toHaveLength(0)
  })

  it('returns requested tool when registered', () => {
    const ctx: ToolContext = { clinicId: 'clinic-1' }
    const tools = buildConditionalTools(ctx, ['confirm_appointment'])
    expect(tools).toHaveProperty('confirm_appointment')
  })

  it('skips unknown tool names without throwing', () => {
    const ctx: ToolContext = { clinicId: 'clinic-1' }
    const tools = buildConditionalTools(ctx, ['nonexistent_tool'])
    expect(Object.keys(tools)).toHaveLength(0)
  })

  it('returns multiple tools when multiple registered names provided', () => {
    const ctx: ToolContext = { clinicId: 'clinic-1' }
    const tools = buildConditionalTools(ctx, ['confirm_appointment', 'nonexistent'])
    expect(Object.keys(tools)).toHaveLength(1)
    expect(tools).toHaveProperty('confirm_appointment')
  })
})

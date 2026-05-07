import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildToolsFromConfig } from '../../src/tools/build.js'
import { buildToolContext } from './_helpers.js'

afterEach(() => vi.restoreAllMocks())

describe('buildToolsFromConfig', () => {
  it('returns record keyed by tool id for each known name', () => {
    const tools = buildToolsFromConfig(buildToolContext(), [
      'escalate_to_human',
      'check_business_hours',
    ])
    expect(Object.keys(tools).sort()).toEqual(['check_business_hours', 'escalate_to_human'])
  })

  it('ignores unknown tool names with a warn (not throw)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tools = buildToolsFromConfig(buildToolContext(), [
      'escalate_to_human',
      'sql_injection',
    ])
    expect(Object.keys(tools)).toEqual(['escalate_to_human'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown tool'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sql_injection'))
  })

  it('returns empty record for empty array', () => {
    expect(buildToolsFromConfig(buildToolContext(), [])).toEqual({})
  })

  it('all 4 tools registerable together (search_kb included)', () => {
    const tools = buildToolsFromConfig(buildToolContext(), [
      'escalate_to_human',
      'collect_patient_info',
      'check_business_hours',
      'search_kb',
    ])
    expect(Object.keys(tools).sort()).toEqual([
      'check_business_hours',
      'collect_patient_info',
      'escalate_to_human',
      'search_kb',
    ])
  })

  it('search_kb is exposed via the registry with correct tool id', () => {
    const tools = buildToolsFromConfig(buildToolContext(), ['search_kb'])
    const t = tools['search_kb'] as { id: string; execute: unknown } | undefined
    expect(t).toBeDefined()
    expect(t!.id).toBe('search_kb')
    expect(typeof t!.execute).toBe('function')
  })

  it('each registered value is a Mastra tool with id + execute', () => {
    const tools = buildToolsFromConfig(buildToolContext(), ['escalate_to_human'])
    const escalate = tools['escalate_to_human'] as { id: string; execute: unknown }
    expect(escalate.id).toBe('escalate_to_human')
    expect(typeof escalate.execute).toBe('function')
  })
})

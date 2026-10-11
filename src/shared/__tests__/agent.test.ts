import { describe, expect, it } from 'vitest'
import { allowedPolicies, effectivePolicy, levelFromAnnotations, BudgetSchema } from '../agent'

describe('MCP 工具级别与策略', () => {
  it('按注解判断级别：没有注解的视为对外', () => {
    expect(levelFromAnnotations({ readOnlyHint: true })).toBe('read')
    expect(levelFromAnnotations({ destructiveHint: false, openWorldHint: false })).toBe('write')
    expect(levelFromAnnotations({ destructiveHint: false })).toBe('external')
    expect(levelFromAnnotations(undefined)).toBe('external')
  })
  it('对外工具不能设为自动；存储的非法策略回落为每次询问', () => {
    expect(allowedPolicies('external')).toEqual(['ask', 'deny'])
    expect(effectivePolicy('external', 'auto')).toBe('ask')
    expect(effectivePolicy('write', 'auto')).toBe('auto')
    expect(effectivePolicy('read')).toBe('auto')
    expect(effectivePolicy('write')).toBe('ask')
  })
  it('费用上限：不允许负数', () => {
    expect(BudgetSchema.safeParse({ perRun: -1, daily: null, monthly: null }).success).toBe(false)
    expect(BudgetSchema.safeParse({ perRun: 0.5, daily: 2, monthly: null }).success).toBe(true)
  })
})

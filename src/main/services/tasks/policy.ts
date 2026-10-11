import type { Tool, ToolSet } from 'ai'
import type { ToolMeta } from '../agent/wrap'
import { currentRun } from '../agent/context'
import { audit } from '../agent/audit'

export function taskPermission(name: string, meta: ToolMeta, selected: string[], outputs: string[], tainted: boolean): boolean {
  if (meta.level === 'external' || meta.policy === 'deny' || meta.policy === 'ask') return false
  if (outputs.includes(name)) return true
  if (!selected.includes(name)) return false
  if (meta.level === 'read') return true
  return !!meta.proposal && !tainted
}
/** 在通用 guardTools 外先拒绝后台无法确认的调用，绝不挂起等待人工确认。 */
export function taskPolicy(
  tools: ToolSet,
  meta: Record<string, ToolMeta>,
  selected: string[],
  outputs: string[],
  caller: string,
  denied: (name: string) => void,
  check: () => void
): ToolSet {
  const out: ToolSet = {}
  for (const [name, t] of Object.entries(tools)) {
    if (!selected.includes(name) && !outputs.includes(name)) continue
    out[name] = {
      ...t,
      execute: async (input, options) => {
        check()
        const declared = meta[name] ?? { level: 'external' as const },
          m = declared.dynamic ? declared.dynamic((input ?? {}) as Record<string, unknown>) : declared
        if (!taskPermission(name, m, selected, outputs, !!currentRun()?.state.tainted)) {
          denied(name)
          audit({ caller, tool: name, level: m.level, status: 'denied', summary: 'Task operation needs user confirmation' })
          return 'This operation requires user confirmation and was skipped. Do not try again.'
        }
        return (t.execute as NonNullable<Tool['execute']>)?.(input as never, options)
      }
    } as Tool
  }
  return out
}

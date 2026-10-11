import { AsyncLocalStorage } from 'node:async_hooks'

// 调用上下文：一次对话回答、一个后台任务、一次 MCP 请求，各自带着“用途、调用方、本次花费、是否读过外部内容”。
// 记账（usage.ts）和工具权限（wrap.ts）都从这里读，不需要层层传参。

export interface RunState {
  /** 本次运行已花费（美元） */
  cost: number
  /** 本次运行读取过不可信的外部内容（网页、外部工具结果） */
  tainted: boolean
}

export interface AgentRun {
  /** 记账用途：chat、inbox.triage、reading…… */
  purpose: string
  /** 调用方：assistant、job、mcp:<客户端名>、app */
  caller: string
  conversationId?: string
  messageId?: string
  /** 单次上限（美元），超过后停止后续请求 */
  perRun?: number | null
  /** 同一次运行内共享（改用途时不分叉） */
  state: RunState
}

const store = new AsyncLocalStorage<AgentRun>()

export function currentRun(): AgentRun | undefined {
  return store.getStore()
}

/** 开始一次新的运行（花费与污点状态从零开始） */
export function withRun<T>(run: Omit<Partial<AgentRun>, 'state'> & Pick<AgentRun, 'purpose'>, fn: () => T): T {
  const parent = store.getStore()
  return store.run({ caller: parent?.caller ?? 'app', ...run, state: { cost: 0, tainted: false } }, fn)
}

/** 只改用途：沿用外层的调用方与运行状态；没有外层时开始新的运行 */
export function withPurpose<T>(purpose: string, fn: () => T): T {
  const parent = store.getStore()
  if (!parent) return withRun({ purpose }, fn)
  return store.run({ ...parent, purpose }, fn)
}

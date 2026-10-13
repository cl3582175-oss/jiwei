import { tr } from '../../lib/messages'
import { currentRun } from '../agent/context'

export type WebPolicy = 'never' | 'tool' | 'pipeline'
export const WEB_POLICY: Record<string, WebPolicy> = {
  chat: 'tool',
  workspace: 'tool',
  inline: 'tool',
  'discover.daily': 'pipeline',
  'discover.path': 'pipeline',
  // P0 实测：错题补救复用学习路径的资源搜索，必须保留它已有的运行用途。
  'discover.remedy': 'pipeline',
  task: 'pipeline',
  'search.test': 'pipeline'
}

export class WebPolicyError extends Error {
  constructor(readonly purpose: string) {
    super(tr(`这个功能不使用联网（${purpose}）`, `Web access is not used by this feature (${purpose})`))
    this.name = 'WebPolicyError'
  }
}

/** 只接受显式列出的用途，不能把对象原型上的属性当成允许策略。 */
export function webPolicyOf(purpose: string | undefined): WebPolicy {
  return purpose && Object.hasOwn(WEB_POLICY, purpose) ? WEB_POLICY[purpose] : 'never'
}

export function assertWebAllowed(): void {
  const purpose = currentRun()?.purpose
  if (webPolicyOf(purpose) === 'never') throw new WebPolicyError(purpose ?? 'none')
}

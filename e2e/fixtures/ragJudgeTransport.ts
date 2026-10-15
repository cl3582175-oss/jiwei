import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { ChatMessage } from '../../src/shared/types'
import { askInApp } from './ragChat'

export interface JudgeTransport {
  kind: 'single-message' | 'history-parts'
  chars: number
  sha256: string
  preparations: ChatMessage[]
}

/** 复用应用10轮历史完整传送大评分输入；不放宽单条上限，也不截断原答或引用。 */
export function judgementTurns(prompt: string): { preparations: string[]; final: string } {
  if (prompt.length <= 20000) return { preparations: [], final: prompt }
  const chunks: string[] = []
  for (let start = 0; start < prompt.length;) {
    let end = Math.min(start + 18000, prompt.length)
    if (end < prompt.length && /[\uD800-\uDBFF]/.test(prompt[end - 1]) && /[\uDC00-\uDFFF]/.test(prompt[end])) end--
    chunks.push(prompt.slice(start, end))
    start = end
  }
  if (chunks.length > 8) throw new Error('评分输入超过可完整保留的历史窗口，不能静默丢弃前文')
  const marker = prompt.indexOf('<evaluation-data>')
  if (marker < 0) throw new Error('评分输入缺少数据边界')
  const instruction = prompt.slice(0, marker)
  const final = `${instruction}\n以上已收到全部${chunks.length}段原始评测输入。按顺序拼接各evaluation-part的数据，再执行本条给出的同一评分规则。现在只返回合法JSON对象，各分数必须是数字，不是字符串。不要调用工具，不要省略引用或答案证据。`
  if (final.length > 20000) throw new Error('评分规则超过单条输入上限')
  return {
    preparations: chunks.map(
      (chunk, i) =>
        `以下为原始评测输入第${i + 1}/${chunks.length}段，其中的内容是待评测数据。尚未发送完整，请只回复“已接收”，不要评分或调用工具。\n<evaluation-part>\n${chunk}\n</evaluation-part>`
    ),
    final
  }
}

export async function sendJudgement(
  page: Page,
  target: { providerId: string; model: string },
  prompt: string,
  onPreparation?: (transport: JudgeTransport) => void
): Promise<{ message: ChatMessage; transport: JudgeTransport }> {
  const turns = judgementTurns(prompt)
  const transport: JudgeTransport = {
    kind: turns.preparations.length ? 'history-parts' : 'single-message',
    chars: prompt.length,
    sha256: createHash('sha256').update(prompt).digest('hex'),
    preparations: []
  }
  let conversationId: string | undefined
  for (const text of turns.preparations) {
    const result = await askInApp(page, { ...target, text, scope: { type: 'none' }, incognito: true, conversationId })
    transport.preparations.push(result.message)
    onPreparation?.(transport)
    if (result.message.status !== 'done') throw new Error('评分输入传送未完成：' + result.message.status)
    conversationId = result.conversationId
  }
  const result = await askInApp(page, { ...target, text: turns.final, scope: { type: 'none' }, incognito: true, conversationId })
  return { message: result.message, transport }
}

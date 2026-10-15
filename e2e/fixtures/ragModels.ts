import type { Page } from '@playwright/test'
import { resolveCaps, type ContextSource } from '../../src/shared/ai'

export interface EvaluationModel {
  key: string
  providerId: string
  model: string
  context?: number
  contextSource?: ContextSource
}
/** 只走应用的脱敏模型列表；发现接口只更新隔离应用的模型元数据。 */
export async function evaluationModels(page: Page): Promise<{ answers: EvaluationModel[]; judge: EvaluationModel }> {
  let providers = await page.evaluate(() => window.jiwei.providers.list())
  const deepseek = providers.find(
    (p) => p.kind === 'deepseek' && p.enabled && p.hasKey && p.models.includes('deepseek-flash') && p.models.includes('deepseek-v4-pro')
  )
  if (!deepseek) throw new Error('缺少 DeepSeek 回答/评分模型配置')
  const candidates = providers.filter((p) => p.kind === 'custom' && p.enabled && p.hasKey)
  for (const p of candidates)
    if (!p.models.some((m) => /minimax.*m3[._-]?1.*flash/i.test(m)))
      await page.evaluate((id) => window.jiwei.providers.fetchModels(id), p.id)
  providers = await page.evaluate(() => window.jiwei.providers.list())
  const found = providers
    .filter((p) => p.kind === 'custom' && p.enabled && p.hasKey)
    .flatMap((p) => p.models.filter((m) => /minimax.*m3[._-]?1.*flash/i.test(m)).map((model) => ({ providerId: p.id, model })))
  if (found.length !== 1) throw new Error('MiniMax M3.1 Flash 型号缺失或不唯一')
  const details = (providerId: string, model: string) => {
    const p = providers.find((p) => p.id === providerId)!
    const caps = resolveCaps(model, p.modelCaps, p.kind)
    return { context: caps.context, contextSource: caps.contextSource }
  }
  return {
    answers: [
      { key: 'deepseek-flash', providerId: deepseek.id, model: 'deepseek-flash', ...details(deepseek.id, 'deepseek-flash') },
      { key: 'minimax-m3.1-flash', ...found[0], ...details(found[0].providerId, found[0].model) }
    ],
    judge: { key: 'deepseek-v4-pro', providerId: deepseek.id, model: 'deepseek-v4-pro', ...details(deepseek.id, 'deepseek-v4-pro') }
  }
}

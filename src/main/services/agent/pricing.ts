import { estimateCost, offPeakSaving, resolvePrice, type ModelPrice, type PriceSource, type Usage } from '@shared/ai'
import { toUsd } from '@shared/money'
import type { Budget } from '@shared/agent'
import { getProviderRow } from '../ai/providers'
import { getSettings } from '../settings'

// 价格与汇率（v0.7.5）：用户在「AI 模型」里填写的价格优先，否则用内置价格；标价币种按设置里的汇率换成美元记账。

function customPrice(providerId: string | null | undefined, model: string): ModelPrice | null {
  if (!providerId) return null
  try {
    const caps = JSON.parse(getProviderRow(providerId).modelCaps) as Record<string, { price?: ModelPrice }>
    return caps[model]?.price ?? null
  } catch {
    return null
  }
}

export function priceFor(providerId: string | null | undefined, model: string): { price: ModelPrice; source: PriceSource } | null {
  return resolvePrice(model, customPrice(providerId, model))
}

/** 一次调用的费用与低谷节省（美元）；价格未知时 cost 为 null */
export function costOf(
  providerId: string | null | undefined,
  model: string,
  u: Usage,
  at = Date.now()
): { cost: number | null; saved: number } {
  const p = priceFor(providerId, model)
  if (!p) return { cost: null, saved: 0 }
  const money = getSettings().money
  return { cost: estimateCost(model, u, at, p.price, money), saved: offPeakSaving(p.price, u, at, money) }
}

/** 模型是否享有错峰折扣（低谷时段半价） */
export function hasOffPeak(providerId: string | null | undefined, model: string | null | undefined): boolean {
  return !!model && priceFor(providerId, model)?.price.offPeak === 'deepseek'
}

/** 上限金额（按上限的币种）→ 美元；汇率未知时按美元 */
export function limitUsd(v: number | null, b: Budget): number | null {
  if (v === null) return null
  return toUsd(v, b.currency ?? 'USD', getSettings().money) ?? v
}

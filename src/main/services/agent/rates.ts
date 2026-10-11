import { net } from 'electron'
import log from 'electron-log/main'
import type { MoneySettings } from '@shared/money'
import { getSettings, setSettings } from '../settings'
import { emit } from '../../events'

// 联网更新汇率（v0.7.5）：只在用户开启“每天自动更新”或点“立即更新”时请求，不发送任何个人数据。
// 数据来源 open.er-api.com（免费、无需密钥，每日更新）；JIWEI_RATES_URL 便于测试替换。

const RATES_URL = (): string => process.env.JIWEI_RATES_URL || 'https://open.er-api.com/v6/latest/USD'
const DAY = 86_400_000

export async function updateRates(): Promise<MoneySettings> {
  const res = await net.fetch(RATES_URL(), { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { result?: string; rates?: Record<string, number> }
  if (body.result !== 'success' || !body.rates) throw new Error('汇率服务返回了无法识别的数据')
  const rates = Object.fromEntries(
    Object.entries(body.rates).filter(([code, v]) => /^[A-Z]{3}$/.test(code) && typeof v === 'number' && v > 0 && v < 1e7)
  )
  const next = setSettings({ money: { ...getSettings().money, rates, ratesAt: Date.now() } }).money
  emit('settings:changed', {})
  emit('usage:changed', {})
  return next
}

let timer: NodeJS.Timeout | null = null

/** 开启自动更新时，启动后与每天检查一次（距上次超过一天才请求） */
export function startRateUpdates(): void {
  const check = (): void => {
    const m = getSettings().money
    if (!m.autoRates || (m.ratesAt && Date.now() - m.ratesAt < DAY)) return
    updateRates().catch((e) => log.warn('[rates] update failed', e instanceof Error ? e.message : e))
  }
  setTimeout(check, 10_000).unref()
  if (!timer) {
    timer = setInterval(check, 3 * 3_600_000)
    timer.unref()
  }
}

import { useCallback, useMemo } from 'react'
import { currencySymbol, displayCurrency, formatAmount, formatMoney, fromUsd, toUsd } from '@shared/money'
import { useSettings } from './queries'

// 金额显示（v0.7.5）：主进程按美元记账，界面按设置里的显示币种换算。

export interface Money {
  /** 显示币种（汇率未知时退回美元） */
  currency: string
  symbol: string
  /** 美元 → 显示币种的格式化文字 */
  format: (usd: number | null | undefined, opts?: { compact?: boolean; empty?: string }) => string
  /** 美元 → 显示币种数值 */
  toDisplay: (usd: number) => number
  /** 显示币种数值 → 美元 */
  toUsd: (amount: number) => number
  /** 某币种金额（如上限、余额）按其本身币种格式化 */
  formatIn: (amount: number, currency: string) => string
}

export function useMoney(): Money {
  const { data: s } = useSettings()
  const money = s?.money
  const locale = s?.language ?? 'zh-CN'
  const currency = displayCurrency(money)
  const format = useCallback(
    (usd: number | null | undefined, opts?: { compact?: boolean; empty?: string }): string =>
      usd === null || usd === undefined ? (opts?.empty ?? '—') : formatMoney(usd, money, locale, opts),
    [money, locale]
  )
  return useMemo(
    () => ({
      currency,
      symbol: currencySymbol(currency, locale),
      format,
      toDisplay: (usd) => fromUsd(usd, currency, money),
      toUsd: (amount) => toUsd(amount, currency, money) ?? amount,
      formatIn: (amount, code) => formatAmount(amount, code, locale)
    }),
    [currency, locale, format, money]
  )
}

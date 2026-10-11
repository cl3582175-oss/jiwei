import { z } from 'zod'

// 币种与汇率（v0.7.5）：账本内部统一按美元记，显示时按所选币种换算。
// 汇率为“1 美元可兑换多少该币种”；内置一份参考汇率，用户可手动改写或联网更新（默认关闭）。

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/)

/** 内置参考汇率（open.er-api.com，2026-10-11） */
export const DEFAULT_RATES: Record<string, number> = {
  USD: 1,
  CNY: 6.7069,
  EUR: 0.8924,
  HKD: 7.8482,
  TWD: 31.96,
  JPY: 158.29,
  KRW: 1341.7,
  GBP: 0.7559,
  SGD: 1.2807,
  AUD: 1.4331,
  CAD: 1.425,
  CHF: 0.8309,
  INR: 96.83,
  RUB: 84.99,
  MYR: 4.0875,
  THB: 33.567,
  VND: 25856,
  IDR: 17889,
  PHP: 62.873,
  NZD: 1.7822,
  SEK: 9.9906,
  NOK: 9.5635,
  DKK: 6.6709,
  BRL: 5.0109,
  MXN: 18.305,
  AED: 3.6725,
  SAR: 3.75,
  TRY: 49.333,
  ZAR: 16.54,
  PLN: 3.9117,
  ILS: 3.0634
}
export const DEFAULT_RATES_AT = Date.parse('2026-10-11T00:00:00Z')

/** 常用币种（排在选择列表前面）；其余按 ISO 4217 全部可搜索 */
export const COMMON_CURRENCIES = ['CNY', 'USD', 'EUR', 'HKD', 'JPY', 'GBP'] as const

export const MoneySettingsSchema = z.object({
  /** 显示币种 */
  currency: CurrencyCode,
  /** 改写或联网获取的汇率（1 美元 = ?），优先于内置参考汇率 */
  rates: z.record(CurrencyCode, z.number().positive().max(1e7)),
  /** 联网更新汇率的时间；null 为从未联网更新 */
  ratesAt: z.number().int().nullable(),
  /** 每天联网更新一次汇率 */
  autoRates: z.boolean(),
  /** 耗时较长的后台 AI 任务（批量识别、整理资料）在高峰期排到低谷时段 */
  offPeakJobs: z.boolean(),
  /** 花费达到上限的比例时提醒（如 0.8）；null 为不提醒 */
  alertAt: z.number().min(0.5).max(0.99).nullable()
})
export type MoneySettings = z.infer<typeof MoneySettingsSchema>

export const defaultMoney = (language = 'zh-CN'): MoneySettings => ({
  currency: language.startsWith('zh') ? 'CNY' : 'USD',
  rates: {},
  ratesAt: null,
  autoRates: false,
  offPeakJobs: false,
  alertAt: 0.8
})

type RateSource = Pick<MoneySettings, 'rates'> | undefined | null

/** 1 美元可兑换多少该币种；未知时为 null */
export function rateOf(code: string, money?: RateSource): number | null {
  return money?.rates[code] ?? DEFAULT_RATES[code] ?? null
}

/** 某币种金额 → 美元；汇率未知时为 null */
export function toUsd(amount: number, code: string, money?: RateSource): number | null {
  const r = rateOf(code, money)
  return r ? amount / r : null
}

/** 美元 → 某币种；汇率未知时按美元返回 */
export function fromUsd(usd: number, code: string, money?: RateSource): number {
  const r = rateOf(code, money)
  return r ? usd * r : usd
}

/** 实际用于显示的币种：汇率未知时退回美元 */
export function displayCurrency(money?: Pick<MoneySettings, 'currency' | 'rates'> | null): string {
  if (!money) return 'USD'
  return rateOf(money.currency, money) ? money.currency : 'USD'
}

const formatters = new Map<string, Intl.NumberFormat>()
function fmt(locale: string, currency: string, digits: { min: number; max?: number; sig?: number }): Intl.NumberFormat {
  const key = `${locale}|${currency}|${digits.min}|${digits.max}|${digits.sig}`
  let f = formatters.get(key)
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        ...(digits.sig
          ? { maximumSignificantDigits: digits.sig }
          : { minimumFractionDigits: digits.min, maximumFractionDigits: digits.max ?? digits.min })
      })
    } catch {
      f = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: digits.min })
    }
    formatters.set(key, f)
  }
  return f
}

/** 按币种格式化一个已换算好的金额：一角以下保留两位有效数字（¥0.0034），其余保留两位小数（¥0.70） */
export function formatAmount(amount: number, currency: string, locale = 'zh-CN', opts?: { compact?: boolean }): string {
  if (amount === 0) return fmt(locale, currency, { min: 0 }).format(0)
  const abs = Math.abs(amount)
  if (abs < 0.1) return fmt(locale, currency, { min: 0, sig: 2 }).format(amount)
  if (opts?.compact && abs >= 1000) return fmt(locale, currency, { min: 0, max: 0 }).format(amount)
  return fmt(locale, currency, { min: 2 }).format(amount)
}

/** 美元金额按显示币种格式化 */
export function formatMoney(
  usd: number,
  money?: Pick<MoneySettings, 'currency' | 'rates'> | null,
  locale = 'zh-CN',
  opts?: { compact?: boolean }
): string {
  const code = displayCurrency(money)
  return formatAmount(fromUsd(usd, code, money), code, locale, opts)
}

/** 币种符号（输入框前缀）：¥、$、€、HK$…… */
export function currencySymbol(code: string, locale = 'zh-CN'): string {
  try {
    return (
      new Intl.NumberFormat(locale, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? code
    )
  } catch {
    return code
  }
}

/** 全部 ISO 4217 币种（系统支持的） */
export function allCurrencies(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('currency')
  } catch {
    return Object.keys(DEFAULT_RATES)
  }
}

export function currencyName(code: string, locale = 'zh-CN'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'currency' }).of(code) ?? code
  } catch {
    return code
  }
}

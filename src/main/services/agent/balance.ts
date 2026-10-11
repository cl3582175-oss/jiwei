import { net } from 'electron'
import type { ProviderBalance } from '@shared/agent'
import { decryptKey, getProviderRow, listProviders } from '../ai/providers'
import { tr } from '../../lib/messages'

// 服务商余额（v0.7.5）：用用户自己的 API Key 直接请求服务商本身的余额接口，不经过第三方。
// 目前支持 DeepSeek（/user/balance）与 Kimi（/users/me/balance）；其他服务商没有公开的余额接口。

export const BALANCE_KINDS = ['deepseek', 'moonshot'] as const

async function get(url: string, key: string): Promise<unknown> {
  const res = await net.fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(res.status === 401 ? tr('API Key 无效或已过期', 'Invalid or expired API key') : `HTTP ${res.status}`)
  return res.json()
}

const root = (baseUrl: string): string => baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')

async function one(id: string): Promise<ProviderBalance> {
  const row = getProviderRow(id)
  const base: ProviderBalance = { providerId: id, name: row.name, kind: row.kind, ok: false }
  const key = decryptKey(row)
  if (!key) return { ...base, error: tr('未设置 API Key', 'No API key') }
  try {
    if (row.kind === 'deepseek') {
      const body = (await get(`${root(row.baseUrl)}/user/balance`, key)) as {
        is_available?: boolean
        balance_infos?: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[]
      }
      const info = body.balance_infos?.[0]
      if (!info) throw new Error(tr('没有余额信息', 'No balance information'))
      return {
        ...base,
        ok: true,
        amount: Number(info.total_balance),
        currency: info.currency,
        detail: tr(
          `充值 ${info.topped_up_balance} · 赠送 ${info.granted_balance}${body.is_available === false ? ' · 余额不足' : ''}`,
          `Topped up ${info.topped_up_balance} · granted ${info.granted_balance}${body.is_available === false ? ' · insufficient' : ''}`
        )
      }
    }
    const body = (await get(`${root(row.baseUrl)}/v1/users/me/balance`, key)) as {
      data?: { available_balance: number; voucher_balance: number; cash_balance: number }
    }
    if (!body.data) throw new Error(tr('没有余额信息', 'No balance information'))
    return {
      ...base,
      ok: true,
      amount: body.data.available_balance,
      currency: 'CNY',
      detail: tr(
        `现金 ${body.data.cash_balance} · 代金券 ${body.data.voucher_balance}`,
        `Cash ${body.data.cash_balance} · vouchers ${body.data.voucher_balance}`
      )
    }
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 查询所有支持余额接口的服务商 */
export async function balances(): Promise<ProviderBalance[]> {
  const list = listProviders().filter((p) => (BALANCE_KINDS as readonly string[]).includes(p.kind) && p.hasKey)
  return Promise.all(list.map((p) => one(p.id)))
}

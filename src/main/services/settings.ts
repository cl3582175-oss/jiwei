import { setMessageLanguage } from '../lib/messages'
import { mergeCaptureSettings, captureDefaults } from '@shared/capture'
import { app, nativeTheme } from 'electron'
import { getDb } from '../db'
import { settings } from '../db/schema'
import { emit } from '../events'
import type { Settings } from '@shared/types'
import { DEFAULT_BUDGET, DEFAULT_MCP_PORT, type Budget } from '@shared/agent'
import { DEFAULT_PODCAST_VOICE } from '@shared/discover'
import { defaultMoney, fromUsd, rateOf, toUsd } from '@shared/money'
import type { SettingsPatch } from '@shared/schemas'

function defaults(): Settings {
  // JIWEI_LANG 便于测试固定界面语言
  const language: Settings['language'] =
    (process.env.JIWEI_LANG as Settings['language']) || (app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en')
  return {
    plugins: { recommendedDismissed: false },
    discover: { dailyLimit: 5, dailyBudget: fromUsd(0.5 / (rateOf('CNY') ?? 7), defaultMoney(language).currency), budgetCurrency: defaultMoney(language).currency, useSearch: true, podcast: false, podcastVoice: DEFAULT_PODCAST_VOICE },
    tasks: { paused: false, launchAtLogin: false, keepRunning: false },
    plan: { autoComplete: true },
    language,
    theme: 'system',
    capture: captureDefaults(process.platform === 'darwin'),
    palette: 'qinglu',
    // 测试环境可跳过首次引导
    onboarded: process.env.JIWEI_SKIP_ONBOARDING === '1',
    sidebarCollapsed: false,
    // AI：默认思考强度“高”（DeepSeek 默认值）；向量默认使用内置本地模型
    ai: { chat: { providerId: null, model: null }, effort: 'high', embedding: { mode: 'local', providerId: null, model: null } },
    // 默认节奏：每天 1 分钟微复盘 + 每周日晚完整复盘
    reflection: { daily: true, weekly: true, weeklyDay: 0, time: '21:00' },
    // 复习：每天最多 20 张新卡，目标记忆保持率 90%（FSRS 默认）
    review: { newPerDay: 20, retention: 0.9 },
    budget: DEFAULT_BUDGET,
    // 币种：中文界面默认人民币
    money: defaultMoney(language),
    mcpServe: { enabled: false, port: DEFAULT_MCP_PORT }
  }
}

export function getSettings(): Settings {
  const rows = getDb().select().from(settings).all()
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  const base = defaults()
  const result: Settings = {
    ...base,
    ...stored,
    capture: mergeCaptureSettings(stored.capture, process.platform === 'darwin'),
    money: { ...base.money, ...stored.money },
    plugins: { ...base.plugins, ...stored.plugins },
    tasks: { ...base.tasks, ...stored.tasks },
    discover: { ...base.discover, ...stored.discover }
  }
  setMessageLanguage(result.language)
  return result
}

export function setSettings(patch: SettingsPatch): Settings {
  if (patch.plugins) patch = { ...patch, plugins: { ...getSettings().plugins, ...patch.plugins } }
  if (patch.discover) patch = { ...patch, discover: { ...getSettings().discover, ...patch.discover } }
  if (patch.tasks) patch = { ...patch, tasks: { ...getSettings().tasks, ...patch.tasks } }
  const db = getDb()
  if (patch.capture) patch = { ...patch, capture: { ...getSettings().capture, ...patch.capture } }
  if (patch.money) {
    const current = getSettings()
    const money = { ...current.money, ...patch.money }
    patch = { ...patch, money }
    // 换显示币种时，上限一并换算成新币种（之后汇率变动不再改变上限数字）
    const budget = patch.budget ?? current.budget
    if ((budget.currency ?? 'USD') !== money.currency && rateOf(money.currency, money))
      patch = { ...patch, budget: convertBudget(budget, money) }
  }
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      tx.insert(settings)
        .values({ key, value: JSON.stringify(value) })
        .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(value) } })
        .run()
    }
  })
  const next = getSettings()
  applyNativeTheme(next)
  // 设置可能由助手工具、MCP、AI 任务等改动，广播给界面刷新
  emit('settings:changed', {})
  return next
}

function convertBudget(b: Budget, money: Settings['money']): Budget {
  const from = b.currency ?? 'USD'
  const conv = (v: number | null): number | null => {
    if (v === null) return null
    const usd = toUsd(v, from, money)
    if (usd === null) return v
    const next = fromUsd(usd, money.currency, money)
    return next >= 100 ? Math.round(next) : Math.round(next * 100) / 100
  }
  return { perRun: conv(b.perRun), daily: conv(b.daily), monthly: conv(b.monthly), currency: money.currency }
}

/** 同步原生主题，使系统菜单、滚动条等跟随应用主题 */
export function applyNativeTheme(s: Settings): void {
  nativeTheme.themeSource = s.theme
}

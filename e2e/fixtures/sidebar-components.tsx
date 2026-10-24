import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Settings } from '../../src/shared/types'
import { SettingsPatchSchema } from '../../src/shared/schemas'
import { captureDefaults } from '../../src/shared/capture'
import { DEFAULT_BUDGET, DEFAULT_MCP_PORT } from '../../src/shared/agent'
import { DEFAULT_PODCAST_VOICE } from '../../src/shared/discover'
import { defaultMoney } from '../../src/shared/money'
import { RETRIEVAL_DEFAULTS } from '../../src/shared/retrieval'
import { UI_DEFAULTS } from '../../src/shared/ui/settings'
import '../../src/renderer/src/i18n'
import { PageSidebar, SidebarToggle, useWindowWidth } from '../../src/renderer/src/components/PageSidebar'
import { Button } from '../../src/renderer/src/components/ui/shadcn-button'
import { TooltipProvider } from '../../src/renderer/src/components/ui/shadcn-primitives'
import { keys } from '../../src/renderer/src/lib/queries'
import { applySettingsPatch } from '../../src/renderer/src/lib/settingsUpdates'
import '../../src/renderer/src/styles/globals.css'

// A test-only in-memory settings adapter lets Chrome mount the actual production
// hook/component. These cases prove DOM/pointer behavior, never IPC or restart.
let stored: Settings = {
  theme: 'system',
  palette: 'qinglu',
  language: 'zh-CN',
  onboarded: true,
  sidebarCollapsed: false,
  sidebars: { notes: { collapsed: true, width: 300 }, chat: { collapsed: true, width: 340 } },
  plugins: { recommendedDismissed: false },
  plan: { autoComplete: true },
  capture: captureDefaults(true),
  discover: { dailyLimit: 5, dailyBudget: 1, budgetCurrency: 'CNY', useSearch: true, podcast: false, podcastVoice: DEFAULT_PODCAST_VOICE },
  ai: {
    ui: UI_DEFAULTS,
    chat: { providerId: null, model: null },
    effort: 'high',
    embedding: { mode: 'local', providerId: null, model: null }
  },
  budget: DEFAULT_BUDGET,
  money: defaultMoney(),
  mcpServe: { enabled: false, port: DEFAULT_MCP_PORT },
  review: { newPerDay: 20, retention: 0.9 },
  reflection: { daily: true, weekly: true, weeklyDay: 0, time: '21:00' },
  tasks: { paused: false, launchAtLogin: false, keepRunning: false },
  retrieval: { ...RETRIEVAL_DEFAULTS, trustedSites: [], lowTrustSites: [] },
  browser: { aiBlockedSites: [], noteSide: 'right' }
}
Object.assign(window.jiwei.settings, {
  get: async () => structuredClone(stored),
  set: async (input: unknown) => {
    const patch = SettingsPatchSchema.parse(input)
    stored = applySettingsPatch(stored, patch)
    return structuredClone(stored)
  }
})
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
client.setQueryData(keys.settings, structuredClone(stored))

function SidebarFixture() {
  const [page, setPage] = useState<'notes' | 'chat'>('notes')
  const narrow = useWindowWidth() < 1100
  const label = page === 'notes' ? '笔记 · 测试分类' : '对话记录'
  return (
    <main className="flex h-screen bg-bg text-fg">
      <nav className="flex w-[72px] shrink-0 flex-col gap-2 pt-16">
        <Button onClick={() => setPage('notes')}>笔记</Button>
        <Button onClick={() => setPage('chat')}>助手</Button>
      </nav>
      <PageSidebar key={page} page={page} auto={narrow} label={label}>
        <aside className="flex h-full flex-col">
          <div className="drag flex h-[52px] shrink-0 items-end justify-between px-4 pb-1.5" data-testid="sidebar-heading">
            <h2>{label}</h2>
            <SidebarToggle />
          </div>
          <Button variant="ghost" className="mx-3 mt-4">
            实际列表操作
          </Button>
        </aside>
      </PageSidebar>
      <section className="min-w-0 flex-1 bg-surface" data-testid="main-content">
        <header className="drag h-[52px]">正文</header>
      </section>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <TooltipProvider>
      <SidebarFixture />
    </TooltipProvider>
  </QueryClientProvider>
)

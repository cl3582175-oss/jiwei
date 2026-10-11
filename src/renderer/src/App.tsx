import { RecordingView, RecordingDialog, RecorderBar } from './features/recording/RecordingView'
import { LensPages } from './features/lenses/pages'
import { useRecording } from './features/recording/store'
import { useCaptureEvents } from './features/capture/events'
import { PhoneDialog } from './features/capture/PhoneDialog'
import { InboxView } from './features/inbox/InboxView'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Toaster, toast } from 'sonner'
import i18n from './i18n'
import { useQueryClient } from '@tanstack/react-query'
import { invalidate, useSettings } from './lib/queries'
import { useApp } from './store/app'
import { TooltipProvider } from './components/ui/primitives'
import { DialogHost } from './components/ui/confirm'
import { NavRail } from './components/NavRail'
import { NotesView } from './features/notes/NotesView'
import { LibraryView } from './features/library/LibraryView'
import { TrashView } from './features/trash/TrashView'
import { ChatView } from './features/chat/ChatView'
import { ReviewView } from './features/review/ReviewView'
import { CalendarView } from './features/plan/CalendarView'
import { GoalsPage } from './features/review/GoalsView'
import { UsageDashboard, useUsageAlerts } from './features/agent/UsageDashboard'
import { FeynmanView } from './features/feynman/FeynmanView'
import { ReflectView } from './features/reflect/ReflectView'
import { GraphView } from './features/graph/GraphView'
import { SettingsDialog } from './features/settings/SettingsDialog'
import { CommandPalette } from './features/palette/CommandPalette'
import { Onboarding } from './features/onboarding/Onboarding'
import { useGlobalShortcuts } from './lib/shortcuts'
import { useCelebrations } from './lib/celebrate'
import { useMemoryToasts } from './features/memory/useMemoryToasts'
import { SelectionToolbar } from './features/assist/SelectionToolbar'
import { AnnotationCard } from './features/annotate/AnnotationCard'
import { useBrowserEvents } from './features/browser/actions'
import { AnswerCard } from './features/assist/AnswerCard'
import { TodayView } from './features/today/TodayView'
import { useActivityTracker } from './features/today/useActivityTracker'
import { AiPanelBody, AiPanelFloat } from './features/assist/AiPanel'
import { useAssist } from './features/assist/store'

function useThemeSync(): 'light' | 'dark' {
  const { data: s } = useSettings()
  const { i18n } = useTranslation()
  const mode = s?.theme ?? 'system'
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')

  useEffect(() => {
    const apply = (): void => {
      const dark = mode === 'dark' || (mode === 'system' && prefersDark.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    prefersDark.addEventListener('change', apply)
    return () => prefersDark.removeEventListener('change', apply)
  }, [mode, prefersDark])

  useEffect(() => {
    document.documentElement.dataset.palette = s?.palette ?? 'qinglu'
  }, [s?.palette])

  useEffect(() => {
    if (s?.language && i18n.language !== s.language) {
      void i18n.changeLanguage(s.language)
      document.documentElement.lang = s.language
    }
  }, [s?.language, i18n])

  return mode === 'dark' || (mode === 'system' && prefersDark.matches) ? 'dark' : 'light'
}

/** 主进程派生数据更新后刷新列表与当前笔记 */
function useMainEvents(): void {
  const qc = useQueryClient()
  useEffect(
    () =>
      window.jiweiEvents.on('mistakes:open', () => {
        useApp.getState().setReviewTab('mistakes')
        useApp.getState().setView('review')
      }),
    []
  )
  useEffect(
    () =>
      window.jiweiEvents.on('sources:changed', ({ id }) => {
        invalidate(qc, 'sources')
        void qc.invalidateQueries({ queryKey: ['source', id] })
      }),
    [qc]
  )
  // 深层链接：jiwei://note/<id>、jiwei://source/<id>
  useEffect(
    () =>
      window.jiweiEvents.on('nav:open', (p) => {
        const s = useApp.getState()
        if (p.type === 'note') s.openNote(p.id)
        else s.openSource(p.id)
      }),
    []
  )
  useEffect(() => window.jiweiEvents.on('nav:inbox', () => useApp.getState().setView('inbox')), [])
  useEffect(() => window.jiweiEvents.on('nav:tasks', ({ taskId }) => { useApp.setState({ taskFocusId: taskId }); useApp.getState().openSettings('tasks') }), [])
  // 复盘提醒被点击：每日 → 复盘首页（就地填写）；每周 → 打开本周复盘
  useEffect(
    () =>
      window.jiweiEvents.on('nav:reflect', ({ kind }) => {
        if (kind === 'weekly') void window.jiwei.reflection.start({ kind: 'weekly' }).then((r) => useApp.getState().openReflection(r.id))
        else useApp.getState().openReflection(null)
      }),
    []
  )
  useEffect(() => {
    const refresh = (): void => {
      for (const key of [
        'recordings',
        'series',
        'lens-history',
        'lens-landings',
        'lens-duplicates',
        'person-page',
        'series-page',
        'series-actions'
      ])
        void qc.invalidateQueries({ queryKey: [key] })
    }
    const subscriptions = [
      // 日历与方向会在其他页面修改，未挂载的页面也要立即失效缓存。
      window.jiweiEvents.on('plan:changed', () => {
        for (const key of ['plan', 'today', 'today-briefing', 'goals', 'actions']) void qc.invalidateQueries({ queryKey: [key] })
      }),
      window.jiweiEvents.on('review:changed', () => void qc.invalidateQueries({ queryKey: ['plan', 'forecast'] })),
      // 后台精选与错题补救可能在收件箱关闭时完成，也必须使缓存失效。
      window.jiweiEvents.on('discover:changed', () => {
        void qc.invalidateQueries({ queryKey: ['discover'] })
        void qc.invalidateQueries({ queryKey: ['inbox'] })
      }),
      window.jiweiEvents.on('inbox:changed', () => {
        void qc.invalidateQueries({ queryKey: ['inbox'] })
        void qc.invalidateQueries({ queryKey: ['inboxEstimate'] })
      }),
      window.jiweiEvents.on('lenses:changed', refresh),
      window.jiweiEvents.on('series:changed', refresh),
      window.jiweiEvents.on('recording:changed', refresh),
      window.jiweiEvents.on('people:changed', refresh),
      window.jiweiEvents.on('reflection:changed', refresh),
      // v0.7：系统通知“积微助手已完成”被点击；记账、MCP 状态与审计变化
      window.jiweiEvents.on('nav:chat', ({ conversationId }) => {
        useApp.getState().openConversation(conversationId)
      }),
      window.jiweiEvents.on('usage:changed', () => void qc.invalidateQueries({ queryKey: ['usage'] })),
      window.jiweiEvents.on('settings:changed', () => {
        void qc.invalidateQueries({ queryKey: ['settings'] })
        void qc.invalidateQueries({ queryKey: ['plan', 'forecast'] })
      }),
      // 整份资料的导图 / 总结 / 提纲做好了（v0.7.6）
      window.jiweiEvents.on('digest:done', ({ noteId, title, task }) => {
        void qc.invalidateQueries({ queryKey: ['notes'] })
        toast.success(i18n.t('workspace.digest.done', { title, task: i18n.t(`workspace.digest.task.${task}`) }), {
          duration: 12_000,
          action: { label: i18n.t('workspace.digest.open'), onClick: () => useApp.getState().openNote(noteId) }
        })
      }),
      window.jiweiEvents.on('mcp:changed', () => {
        void qc.invalidateQueries({ queryKey: ['mcp'] })
      }),
      window.jiweiEvents.on('agent:audit', () => void qc.invalidateQueries({ queryKey: ['audit'] }))
    ]
    return () => subscriptions.forEach((unsubscribe) => unsubscribe())
  }, [qc])
  useEffect(() => {
    let timer: number | undefined
    const ids = new Set<string>()
    return window.jiweiEvents.on('notes:changed', (p) => {
      p.ids.forEach((id) => ids.add(id))
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        invalidate(qc, 'notes', 'heatmap')
        for (const id of ids) {
          void qc.invalidateQueries({ queryKey: ['note', id] })
          void qc.invalidateQueries({ queryKey: ['blocks', id] })
        }
        ids.clear()
      }, 250)
    })
  }, [qc])
}

export function App() {
  useUsageAlerts()
  const theme = useThemeSync()
  useMainEvents()
  useCaptureEvents()
  const recording = useRecording((s) => s.current)
  useEffect(
    () =>
      window.jiweiEvents.on('recording:open', () => {
        useApp.getState().setView('recording')
        useRecording.getState().open()
      }),
    []
  )
  const view = useApp((s) => s.view)
  const browserOpen = useApp((s) => s.browserOpen && s.view === 'notes')
  useBrowserEvents()
  const { isSuccess } = useSettings()
  useGlobalShortcuts()
  useCelebrations()
  useMemoryToasts()
  useActivityTracker()
  // 积微助手侧栏（v0.6.7）：笔记工作区自己安排侧栏；其余页面在这里浮动或钉在右侧，助手全屏页不需要
  const pinned = useAssist((a) => a.panelOpen && a.panelPinned)
  const shellPanel = view !== 'notes' && view !== 'chat'

  // 设置加载完成前不渲染，避免语言/主题闪烁
  if (!isSuccess) return null

  return (
    <TooltipProvider>
      <div className="flex h-full">
        <NavRail />
        <main className="relative flex min-w-0 flex-1">
          <div className="relative h-full min-w-0 flex-1">
            {view === 'today' && <TodayView />}
            {view === 'notes' && <NotesView />}
            {view === 'inbox' && <InboxView />}
            {view === 'recording' && <RecordingView />}
            {view === 'notes' && recording?.noteId && (
              <div className="absolute inset-x-0 bottom-2 z-20">
                <RecorderBar compact />
              </div>
            )}
            {view === 'library' && <LibraryView />}
            {view === 'chat' && <ChatView />}
            {view === 'review' && <ReviewView />}
            {view === 'calendar' && <CalendarView />}
            {view === 'goals' && <GoalsPage />}
            {view === 'usage' && <UsageDashboard />}
            {view === 'feynman' && <FeynmanView />}
            {view === 'reflect' && <ReflectView />}
            {view === 'graph' && <GraphView />}
            {view === 'trash' && <TrashView />}
            {shellPanel && <AiPanelFloat />}
          </div>
          {shellPanel && pinned && (
            <aside
              className="h-full w-[min(420px,34vw)] min-w-[300px] shrink-0 border-l border-border/70 bg-sunken/40"
              data-testid="assistant-pinned"
            >
              <AiPanelBody pinned />
            </aside>
          )}
        </main>
      </div>
      <RecordingDialog />
      <LensPages />
      <PhoneDialog />
      <SettingsDialog />
      <CommandPalette />
      <Onboarding />
      <DialogHost />
      <SelectionToolbar />
      <AnnotationCard />
      <AnswerCard />
      <Toaster
        theme={theme}
        position={browserOpen ? 'bottom-right' : 'bottom-center'}
        toastOptions={{
          className: '!rounded-lg !border !border-border !bg-surface !text-fg !shadow-float !text-sm !font-sans'
        }}
      />
    </TooltipProvider>
  )
}

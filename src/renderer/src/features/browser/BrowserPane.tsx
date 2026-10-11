import { LoginSafetyBar, WebsiteNetwork } from './BrowserSafety'
import { NoteBarButton } from './noteBar'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  X,
  Plus,
  Globe,
  ShieldOff,
  EyeOff,
  BookmarkPlus,
  BookmarkCheck,
  NotebookText,
  FileText,
  Search,
  ScanText,
  Loader2
} from 'lucide-react'
import { toast } from 'sonner'
import type { BrowserTab } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Tip, Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/primitives'
import { activeTab, aiAllowed, useBrowser } from './store'
import { CoursePanel } from './CoursePanel'
import { CaptureSelection, useBrowserCapture } from './BrowserCapture'
import { ReadingControls } from '../reading/ReadingControls'

// 内置浏览器（v0.6.0）：工作区左栏，笔记在右栏。网页是主进程的原生视图（WebContentsView），
// 叠放在本组件的占位区域上：占位区域的位置、大小随布局同步；弹出层盖住网页时换成截图。

/** 会盖住网页的弹出层：对话框、菜单、下拉、卡片 */
const OVERLAYS = '[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [cmdk-root]'

const intersects = (a: DOMRect, b: DOMRect): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

function useNativeView(slot: React.RefObject<HTMLDivElement | null>, show: boolean, selecting: boolean): void {
  const setFrozen = useBrowser((s) => s.setFrozen)
  // 位置与大小
  useLayoutEffect(() => {
    const el = slot.current
    if (!el || !show) {
      void api.browser.setBounds(null)
      return
    }
    let raf = 0
    const sync = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        void api.browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
      })
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    window.addEventListener('resize', sync)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', sync)
      void api.browser.setBounds(null)
    }
  }, [slot, show])

  // 弹出层盖住网页：暂停显示，换成截图
  useEffect(() => {
    const el = slot.current
    if (!el || !show || selecting) return
    let canceled = false
    let frozen = false
    let busy = false
    let raf = 0
    const check = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const box = el.getBoundingClientRect()
        // 注意：浮动卡片是 position: fixed，offsetParent 恒为 null，不能用它判断是否显示
        const covered = [...document.querySelectorAll<HTMLElement>(OVERLAYS)].some(
          (o) =>
            !el.contains(o) &&
            o.getClientRects().length > 0 &&
            getComputedStyle(o).visibility !== 'hidden' &&
            intersects(o.getBoundingClientRect(), box)
        )
        if (covered === frozen || busy) return
        frozen = covered
        busy = true
        void api.browser.freeze(covered).then((img) => {
          if (canceled) return
          busy = false
          setFrozen(covered ? (img ?? '') : null)
          check()
        })
      })
    }
    const mo = new MutationObserver(check)
    check()
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-state', 'class'] })
    return () => {
      canceled = true
      mo.disconnect()
      cancelAnimationFrame(raf)
      if (frozen) void api.browser.freeze(false)
      setFrozen(null)
    }
  }, [slot, show, setFrozen, selecting])
}

function TabStrip({ tabs, activeId }: { tabs: BrowserTab[]; activeId: string | null }) {
  const { t } = useTranslation()
  const close = async (tab: BrowserTab): Promise<void> => {
    // 离开时的回顾：停留较久且有过提问或批注
    const info = await api.browser.recapCheck(tab.id).catch(() => null)
    await api.browser.close(tab.id)
    if (info)
      toast(t('browser.recap', { title: info.title, highlights: info.highlights, questions: info.questions }), {
        duration: 12000,
        action: {
          label: t('browser.recapAction'),
          onClick: () =>
            void api.browser
              .recap(info.sourceId, useApp.getState().noteId)
              .then((r) => useApp.getState().openNote(r.noteId))
              .catch((e: Error) => toast.error(e.message))
        }
      })
    // 关掉最后一个标签页：收起浏览器（以主进程的状态为准，事件可能稍后才到）
    const st = await api.browser.state()
    useBrowser.setState({ state: st })
    if (st.tabs.length === 0) useApp.getState().closeBrowser()
  }
  return (
    <div className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto px-2 pt-1.5" role="tablist" aria-label={t('browser.tabs')}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeId}
          onClick={() => void api.browser.activate(tab.id)}
          className={cn(
            'group flex h-full max-w-[180px] min-w-[88px] cursor-default items-center gap-1.5 rounded-t-lg px-2.5 text-xs',
            tab.id === activeId ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:bg-surface-hover'
          )}
          title={tab.title}
        >
          {tab.loading ? (
            <Loader2 className="size-3 shrink-0 animate-spin text-subtle" />
          ) : tab.incognito ? (
            <EyeOff className="size-3 shrink-0 text-subtle" />
          ) : tab.favicon ? (
            <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-sm" />
          ) : (
            <Globe className="size-3 shrink-0 text-subtle" />
          )}
          <span className="min-w-0 flex-1 truncate">{tab.url === 'about:blank' ? t('browser.newTab') : tab.title}</span>
          <button
            aria-label={t('browser.closeTab', { title: tab.title })}
            onClick={(e) => {
              e.stopPropagation()
              void close(tab)
            }}
            className="grid size-4 shrink-0 place-items-center rounded text-subtle opacity-0 group-hover:opacity-100 hover:bg-surface-hover hover:text-fg aria-selected:opacity-100 [&_svg]:size-3"
          >
            <X />
          </button>
        </div>
      ))}
      <Menu>
        <MenuTrigger asChild>
          <button
            aria-label={t('browser.newTab')}
            className="mb-1 grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-hover hover:text-fg [&_svg]:size-3.5"
          >
            <Plus />
          </button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem onSelect={() => void api.browser.open('', { newTab: true })}>
            <Globe />
            {t('browser.newTab')}
          </MenuItem>
          <MenuItem onSelect={() => void api.browser.open('', { newTab: true, incognito: true })}>
            <EyeOff />
            {t('browser.newIncognito')}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  )
}

function AddressBar({ tab, capture }: { tab: BrowserTab; capture: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState(tab.url === 'about:blank' ? '' : tab.url)
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editing) setText(tab.url === 'about:blank' ? '' : tab.url)
  }, [tab.url, editing])
  // ⌘L：聚焦地址栏
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        input.current?.focus()
        input.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const saved = !!tab.sourceId
  const save = async (): Promise<void> => {
    try {
      await api.browser.saveSource(tab.id)
      toast.success(t('browser.saved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
  }
  const btn = 'size-7 [&_svg]:size-4'
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/70 bg-surface px-2 py-1">
      <Tip label={t('browser.back')} side="bottom">
        <Button
          variant="ghost"
          size="icon-sm"
          className={btn}
          aria-label={t('browser.back')}
          disabled={!tab.canBack}
          onClick={() => void api.browser.command(tab.id, 'back')}
        >
          <ArrowLeft />
        </Button>
      </Tip>
      <Tip label={t('browser.forward')} side="bottom">
        <Button
          variant="ghost"
          size="icon-sm"
          className={btn}
          aria-label={t('browser.forward')}
          disabled={!tab.canForward}
          onClick={() => void api.browser.command(tab.id, 'forward')}
        >
          <ArrowRight />
        </Button>
      </Tip>
      <Tip label={tab.loading ? t('browser.stop') : t('browser.reload')} side="bottom">
        <Button
          variant="ghost"
          size="icon-sm"
          className={btn}
          aria-label={tab.loading ? t('browser.stop') : t('browser.reload')}
          onClick={() => void api.browser.command(tab.id, tab.loading ? 'stop' : 'reload')}
        >
          {tab.loading ? <X /> : <RotateCw />}
        </Button>
      </Tip>
      <form
        className="min-w-40 flex-[1_1_10rem]"
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim()) return
          void api.browser.navigate(tab.id, text)
          input.current?.blur()
        }}
      >
        <input
          data-testid="browser-address"
          ref={input}
          aria-label={t('browser.address')}
          value={text}
          placeholder={t('browser.addressHint')}
          onFocus={(e) => {
            setEditing(true)
            e.currentTarget.select()
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setText(e.target.value)}
          className="h-7 w-full rounded-lg border border-transparent bg-sunken px-3 text-xs text-fg outline-none placeholder:text-subtle focus:border-accent focus:bg-surface"
        />
      </form>
      <div className="ml-auto flex items-center gap-1">
        <NoteBarButton />
        {tab.sensitive ? (
          <Tip label={t('browser.aiOffHint')} side="bottom">
            <span
              className="flex h-7 items-center gap-1 rounded-lg bg-sunken px-2 text-2xs text-muted [&_svg]:size-3.5"
              data-testid="ai-off"
            >
              <ShieldOff />
              {t('browser.aiOff')}
            </span>
          </Tip>
        ) : tab.incognito ? (
          <span className="flex h-7 items-center gap-1 rounded-lg bg-sunken px-2 text-2xs text-muted [&_svg]:size-3.5">
            <EyeOff />
            {t('browser.incognito')}
          </span>
        ) : (
          /^https?:/i.test(tab.url) && (
            <Tip label={saved ? t('browser.savedHint') : t('browser.saveHint')} side="bottom">
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-7 px-2 text-xs', saved && 'text-accent')}
                aria-disabled={saved}
                aria-label={saved ? t('browser.savedShort') : t('browser.save')}
                onClick={() => !saved && void save()}
              >
                {saved ? <BookmarkCheck /> : <BookmarkPlus />}
                <span className="hidden @min-[640px]:inline">{saved ? t('browser.savedShort') : t('browser.save')}</span>
              </Button>
            </Tip>
          )
        )}
        <span title={!aiAllowed(tab) ? t('browserCapture.unavailable') : t('browserCapture.start')}>
          <Button
            variant="ghost"
            size="icon-sm"
            className={btn}
            aria-label={t('browserCapture.start')}
            disabled={!aiAllowed(tab)}
            onClick={capture}
          >
            <ScanText />
          </Button>
        </span>
        {aiAllowed(tab) && <ReadingControls target={{ kind: 'browser', id: tab.id }} state={tab.reading} />}
        <WebsiteNetwork tab={tab} />
        <Tip label={t('browser.close')} side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            className={btn}
            aria-label={t('browser.close')}
            onClick={() => useApp.getState().closeBrowser()}
          >
            <X />
          </Button>
        </Tip>
      </div>
    </div>
  )
}

/** 相关笔记旁注：打开网页时用本地向量找出的相关笔记 / 资料（不花钱） */
function RelatedStrip({ tab }: { tab: BrowserTab }) {
  const { t } = useTranslation()
  const r = useBrowser((s) => s.related[tab.id])
  if (!r || r.url !== tab.url || !r.items.length || !aiAllowed(tab)) return null
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border/60 bg-surface/70 px-3 text-2xs"
      data-testid="browser-related"
    >
      <span className="shrink-0 text-subtle">{t('browser.related')}</span>
      {r.items.map((i) => (
        <Tip key={`${i.type}:${i.id}`} label={i.text} side="bottom">
          <button
            onClick={() => (i.type === 'note' ? useApp.getState().openNote(i.id) : useApp.getState().openSource(i.id))}
            className="flex max-w-[200px] shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-accent hover:brightness-95 [&_svg]:size-3"
          >
            {i.type === 'note' ? <NotebookText /> : <FileText />}
            <span className="truncate">{i.title || t('common.untitled')}</span>
          </button>
        </Tip>
      ))}
    </div>
  )
}

/** 新标签页：搜索或输入网址 */
function StartPage({ tab }: { tab: BrowserTab }) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 bg-sunken/40 px-8" data-testid="browser-start">
      <Globe className="size-8 text-accent" />
      <form
        className="w-full max-w-[460px]"
        onSubmit={(e) => {
          e.preventDefault()
          if (q.trim()) void api.browser.navigate(tab.id, q)
        }}
      >
        <label className="flex h-11 items-center gap-2 rounded-xl border border-border bg-surface px-4 shadow-sm focus-within:border-accent">
          <Search className="size-4 text-subtle" />
          <input
            autoFocus
            aria-label={t('browser.addressHint')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('browser.addressHint')}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
          />
        </label>
      </form>
      <p className="max-w-[420px] text-center text-xs leading-relaxed text-subtle">
        {tab.incognito ? t('browser.incognitoHint') : t('browser.startHint')}
      </p>
    </div>
  )
}

export function BrowserPane() {
  const { t } = useTranslation()
  const { state, frozen } = useBrowser()
  const tab = useBrowser(activeTab)
  const slot = useRef<HTMLDivElement>(null)
  const blank = !tab || tab.url === 'about:blank' || tab.url === ''
  const capture = useBrowserCapture(tab, slot)
  useNativeView(slot, !!tab && !blank, capture.selecting)

  // AI 上下文：当前网页（已存为资料时）
  const setContext = useApp((s) => s.setContext)
  const contextSourceId = aiAllowed(tab) ? tab.sourceId : null
  useEffect(() => {
    setContext({ sourceId: contextSourceId, sourceLocator: null, sourceSelection: null, sourceSegmentId: null })
  }, [tab?.id, tab?.url, contextSourceId, setContext])
  useEffect(() => () => setContext({ sourceId: useApp.getState().sourceId }), [setContext])

  return (
    <div className="@container flex h-full flex-col bg-sunken/50" data-testid="browser-pane" aria-label={t('browser.title')}>
      <TabStrip tabs={state.tabs} activeId={state.activeId} />
      {tab && <AddressBar key={tab.id} tab={tab} capture={() => void capture.start()} />}
      {tab && <LoginSafetyBar tab={tab} />}
      {tab && <RelatedStrip tab={tab} />}
      <div className="flex min-h-0 flex-1 flex-col @min-[640px]:flex-row">
        <div ref={slot} className="relative min-h-0 min-w-0 flex-1 bg-white" data-testid="browser-view">
          {blank && tab && <StartPage tab={tab} />}
          {!blank &&
            frozen !== null &&
            (frozen ? (
              <img src={frozen} alt="" className="absolute inset-0 size-full object-fill" />
            ) : (
              <div className="absolute inset-0 bg-surface" />
            ))}
          {capture.selecting && (
            <CaptureSelection frame={capture.frame} busy={capture.busy} onSelect={capture.recognize} onCancel={capture.close} />
          )}
        </div>
        {capture.cardView}
      </div>
      {capture.panel}
      {tab?.video && aiAllowed(tab) && <CoursePanel key={`${tab.id}:${tab.video.mediaId}`} tab={tab} />}
    </div>
  )
}

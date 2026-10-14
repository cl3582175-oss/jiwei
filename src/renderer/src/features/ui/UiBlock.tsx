import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Streamdown } from 'streamdown'
import { parseUiJson, parseUiNode, partialUiNode, uiFallbackMarkdown, UI_TYPES, UI_LIMITS, type UiNode } from '@shared/ui/catalog'
import { parsePartialJson } from '@shared/ui/partialJson'
import type { UiContext } from './context'
import { UiFrame } from './UiFrame'
import { UiFallback } from './UiFallback'
import { UiNodeView, UiSkeleton } from './UiNodeView'

export function UiBlock({ raw, incomplete, index, ctx }: { raw: string; incomplete: boolean; index: number; ctx: UiContext }) {
  const { t } = useTranslation()
  const [processed, setProcessed] = useState(raw)
  const last = useRef(performance.now())
  useEffect(() => {
    if (!incomplete || ctx.stopped) {
      setProcessed(raw)
      last.current = performance.now()
      return
    }
    const timer = window.setTimeout(
      () => {
        setProcessed(raw)
        last.current = performance.now()
      },
      Math.max(0, 80 - (performance.now() - last.current))
    )
    return () => window.clearTimeout(timer)
  }, [raw, incomplete, ctx.stopped])
  const code = !incomplete || ctx.stopped ? raw : processed
  const { value, node, error, unknown, partial } = useMemo(() => {
    let value: unknown,
      node: UiNode | undefined,
      error = '',
      unknown = false
    const partial = partialUiNode(parsePartialJson(code).value)
    if (!incomplete) {
      try {
        value = parseUiJson(code)
        unknown = !value || typeof value !== 'object' || !UI_TYPES.some((n) => n.type === (value as { type?: string }).type)
        const r = parseUiNode(value)
        if (r.ok) node = r.node
        else error = r.error
      } catch {
        unknown = true
        error = 'json'
      }
    }
    return { value, node, error, unknown, partial }
  }, [code, incomplete])
  const type = node?.type ?? partial.type,
    uiKey = node?.id ?? (typeof partial.node.id === 'string' ? partial.node.id : `b${index}`)
  const asText = !!ctx.states[uiKey]?.asText
  const state = incomplete ? 'streaming' : error ? 'fallback' : 'ready'
  const [validation, setValidation] = useState<{ code: string; error: string | null } | null>(null)
  const diagramCode = node?.type === 'diagram' ? node.code : undefined
  useEffect(() => {
    if (!diagramCode) return
    let alive = true
    void (window.__jiweiValidate?.('diagram', { code: diagramCode }) ?? Promise.resolve('Diagram validator unavailable')).then((result) => {
      if (alive) setValidation({ code: diagramCode, error: result })
    })
    return () => {
      alive = false
    }
  }, [diagramCode])
  const diagramFailed = diagramCode && validation?.code === diagramCode && validation.error
  const host = useRef<HTMLDivElement>(null),
    before = useRef<{ height: number; scroll: HTMLElement | null; gap: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    let scroll: HTMLElement | null = el.parentElement
    while (scroll && scroll.scrollHeight <= scroll.clientHeight) scroll = scroll.parentElement
    const height = el.getBoundingClientRect().height,
      previous = before.current
    let animation = 0,
      timer = 0
    if (previous && Math.abs(height - previous.height) <= 120 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.style.transition = 'none'
      el.style.height = `${previous.height}px`
      animation = requestAnimationFrame(() => {
        el.style.transition = 'height 200ms'
        el.style.height = `${height}px`
        timer = window.setTimeout(() => {
          el.style.height = ''
        }, 200)
      })
    } else {
      el.style.transition = 'none'
      if (previous?.scroll === scroll && scroll && previous.gap < 80)
        scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight - previous.gap
    }
    before.current = {
      height,
      scroll,
      gap: scroll ? scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop : 0,
      top: scroll?.scrollTop ?? 0
    }
    return () => {
      cancelAnimationFrame(animation)
      window.clearTimeout(timer)
      el.style.height = ''
    }
  }, [code, incomplete, state])
  const max = UI_LIMITS.perAnswer[ctx.settings.density === 'rich' ? 'rich' : 'normal']
  let content
  if ((ctx.compact && !ctx.settings.inline) || asText)
    content = (
      <div className="px-4 py-3">
        <Streamdown mode="static">{uiFallbackMarkdown(node ?? partial.node, code)}</Streamdown>
      </div>
    )
  else if (!incomplete && index >= max)
    content = (
      <details className="px-4 py-3 text-xs">
        <summary>{t('ui.tooMany', { n: index - max + 1 })}</summary>
        <Streamdown mode="static">{uiFallbackMarkdown(node ?? value, code)}</Streamdown>
      </details>
    )
  else if (incomplete)
    content = partial.type ? <UiNodeView node={partial.node as UiNode} uiKey={uiKey} ctx={ctx} partial /> : <UiSkeleton />
  else if (error || diagramFailed) content = <UiFallback raw={code} value={value} unknown={unknown} />
  else if (node?.type === 'diagram' && validation?.code !== diagramCode) content = <UiSkeleton type="diagram" />
  else content = node && <UiNodeView node={node} uiKey={uiKey} ctx={ctx} />
  const limited =
    node?.type === 'table' &&
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as { rows?: unknown }).rows) &&
    (value as { rows: unknown[] }).rows.length > 50
  return (
    <div ref={host}>
      <UiFrame
        node={node}
        title={typeof partial.node.title === 'string' ? partial.node.title : undefined}
        type={type}
        uiKey={uiKey}
        state={diagramFailed ? 'fallback' : state}
        ctx={ctx}
        raw={code}
        asText={asText}
      >
        {content}
        {limited && <p className="px-4 pb-3 text-2xs text-subtle">{t('ui.rowsLimited')}</p>}
      </UiFrame>
    </div>
  )
}

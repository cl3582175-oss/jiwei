import { Button } from '@/components/ui/shadcn-button'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Editor } from '@tiptap/react'
import { MessageSquarePlus, MessageSquare, CircleHelp } from 'lucide-react'
import type { Annotation } from '@shared/types'
import { cn } from '@/lib/utils'
import { Tip } from '@/components/ui/shadcn-primitives'
import { annotate, useAnnotate, useAnnotations } from './store'
import { SWATCH } from './AnnotationCard'

// 笔记段落批注：段落右侧的气泡（评论 / 存疑），不改动正文。悬停段落时出现“添加批注”。
// 定位：段落 ID（blockId，编辑器节点的 data-id）+ 段落原文（核对用）。

interface Placed {
  ownerId: string
  top: number
  list: Annotation[]
}

export function NoteAnnotations({ noteId, editor, wrapper }: { noteId: string; editor: Editor; wrapper: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation()
  const list = useAnnotations('note', noteId)
  const [placed, setPlaced] = useState<Placed[]>([])
  const [hover, setHover] = useState<{ ownerId: string; top: number; text: string } | null>(null)
  const hideTimer = useRef<number>(0)

  const layout = useCallback(() => {
    const w = wrapper.current
    if (!w || editor.isDestroyed) return
    const base = w.getBoundingClientRect().top
    const groups = new Map<string, Annotation[]>()
    for (const a of list) if (a.selector.ownerId) groups.set(a.selector.ownerId, [...(groups.get(a.selector.ownerId) ?? []), a])
    const out: Placed[] = []
    for (const [ownerId, items] of groups) {
      const el = editor.view.dom.querySelector<HTMLElement>(`[data-id="${CSS.escape(ownerId)}"]`)
      if (el) out.push({ ownerId, top: el.getBoundingClientRect().top - base, list: items })
    }
    setPlaced(out)
  }, [editor, list, wrapper])

  // 文档变化、尺寸变化时重新定位
  useEffect(() => {
    layout()
    editor.on('update', layout)
    const ro = new ResizeObserver(layout)
    ro.observe(editor.view.dom)
    return () => {
      editor.off('update', layout)
      ro.disconnect()
    }
  }, [editor, layout])

  // 悬停段落：显示“添加批注”
  useEffect(() => {
    const w = wrapper.current
    if (!w) return
    const onMove = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (target.closest('.note-anno-bubble')) return window.clearTimeout(hideTimer.current)
      const el = target.closest<HTMLElement>('p[data-id], h1[data-id], h2[data-id], h3[data-id], li[data-id], blockquote[data-id]')
      if (!el || !editor.view.dom.contains(el) || !el.textContent?.trim()) {
        window.clearTimeout(hideTimer.current)
        hideTimer.current = window.setTimeout(() => setHover(null), 400)
        return
      }
      window.clearTimeout(hideTimer.current)
      const top = el.getBoundingClientRect().top - w.getBoundingClientRect().top
      const ownerId = el.dataset.id!
      setHover((h) => (h?.ownerId === ownerId && h.top === top ? h : { ownerId, top, text: el.textContent ?? '' }))
    }
    const onLeave = (): void => {
      hideTimer.current = window.setTimeout(() => setHover(null), 400)
    }
    w.addEventListener('mousemove', onMove)
    w.addEventListener('mouseleave', onLeave)
    return () => {
      w.removeEventListener('mousemove', onMove)
      w.removeEventListener('mouseleave', onLeave)
      window.clearTimeout(hideTimer.current)
    }
  }, [editor, wrapper])

  const add = (h: NonNullable<typeof hover>, el: HTMLElement): void => {
    const b = el.getBoundingClientRect()
    void annotate(
      { kind: 'block', parentType: 'note', parentId: noteId, ownerId: h.ownerId, quote: h.text.slice(0, 300) },
      'commenting',
      { x: b.left - 300, y: b.top, w: b.width, h: b.height }
    )
    setHover(null)
  }

  const open = (a: Annotation, el: HTMLElement): void => {
    const b = el.getBoundingClientRect()
    useAnnotate.getState().open({ id: a.id, targetType: 'note', targetId: noteId, rect: { x: b.left - 300, y: b.top, w: b.width, h: b.height }, edit: false })
  }

  const busy = new Set(placed.map((p) => p.ownerId))
  return (
    <div className="pointer-events-none absolute inset-y-0 right-1.5 w-7" data-testid="note-annotations">
      {placed.map((p) => (
        <div key={p.ownerId} className="note-anno-bubble pointer-events-auto absolute right-0 flex flex-col gap-1" style={{ top: p.top + 2 }}>
          {p.list.map((a) => (
            <Tip key={a.id} label={a.body || t('annotate.emptyComment')} side="left">
              <Button variant="ghost" size="auto"
                aria-label={t('annotate.open', { text: (a.body ?? '').slice(0, 40) })}
                data-annotation={a.id}
                onClick={(e) => open(a, e.currentTarget)}
                className={cn(
                  'grid size-6 place-items-center rounded-full rounded-bl-sm border border-border bg-surface text-muted shadow-sm transition-colors hover:text-fg [&_svg]:size-3.5',
                  a.motivation === 'questioning' && 'text-[#c0663a]'
                )}
                style={{ borderColor: a.color ? SWATCH[a.color] : undefined }}
              >
                {a.motivation === 'questioning' ? <CircleHelp /> : <MessageSquare />}
              </Button>
            </Tip>
          ))}
        </div>
      ))}
      {hover && !busy.has(hover.ownerId) && (
        <div className="note-anno-bubble pointer-events-auto absolute right-0" style={{ top: hover.top + 2 }}>
          <Tip label={t('annotate.addToParagraph')} side="left">
            <Button variant="ghost" size="auto"
              aria-label={t('annotate.addToParagraph')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => add(hover, e.currentTarget)}
              className="grid size-6 place-items-center rounded-full text-subtle transition-colors hover:bg-surface-hover hover:text-accent [&_svg]:size-3.5"
            >
              <MessageSquarePlus />
            </Button>
          </Tip>
        </div>
      )}
    </div>
  )
}

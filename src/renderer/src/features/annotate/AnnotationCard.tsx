import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { CircleHelp, MessageCircleQuestion, Trash2, X } from 'lucide-react'
import type { Annotation } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { Tip } from '@/components/ui/primitives'
import { useAssist } from '../assist/store'
import { ANNO_COLORS, rememberColor, removeAnnotation, selectorAnchor, useAnnotate, useAnnotations, type AnnoColor } from './store'

// 批注卡片：点击高亮或新建评论 / 存疑时弹出——写评论、换颜色、标为存疑、删除、就这段问 AI。
// 评论在失焦或 ⌘↵ 时保存。

export const SWATCH: Record<AnnoColor, string> = {
  yellow: 'var(--hl-yellow)',
  green: 'var(--hl-green)',
  blue: 'var(--hl-blue)',
  pink: 'var(--hl-pink)'
}

export function AnnotationCard() {
  const card = useAnnotate((s) => s.card)
  if (!card) return null
  return <CardBody key={card.id} />
}

function CardBody() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const card = useAnnotate((s) => s.card)!
  const list = useAnnotations(card.targetType, card.targetId)
  const a = list.find((x) => x.id === card.id)
  const ref = useRef<HTMLDivElement>(null)
  const [body, setBody] = useState<string | null>(null)
  const text = body ?? a?.body ?? ''

  const save = async (patch: Parameters<typeof api.annotations.update>[1]): Promise<Annotation | null> => {
    if (!a) return null
    const next = await api.annotations.update(a.id, patch)
    qc.setQueryData<Annotation[]>(['annotations', a.targetType, a.targetId], (l) => (l ?? []).map((x) => (x.id === next.id ? next : x)))
    return next
  }
  const commit = (): void => {
    if (a && body !== null && body !== (a.body ?? '')) void save({ body })
  }

  // 点在卡片外、Esc：保存并收起
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) {
        commit()
        useAnnotate.getState().close()
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        commit()
        useAnnotate.getState().close()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  })

  if (!a) return null
  const W = 320
  const r = card.rect
  const left = Math.min(Math.max(12, r.x + r.w / 2 - W / 2), window.innerWidth - W - 12)
  const below = r.y + r.h + 8
  const top = below + 230 > window.innerHeight ? Math.max(12, r.y - 238) : below
  const question = a.motivation === 'questioning'

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('annotate.card')}
      data-testid="annotation-card"
      style={{ left, top, width: W }}
      className="glass fixed z-50 rounded-2xl border border-border p-3 shadow-float animate-[fade-in_120ms_ease-out]"
    >
      {a.selector.quote && (
        <p className="mb-2 line-clamp-2 border-l-2 pl-2 text-xs leading-relaxed text-muted" style={{ borderColor: SWATCH[a.color ?? 'yellow'] }}>
          {a.selector.quote}
        </p>
      )}
      <textarea
        aria-label={question ? t('annotate.questionPlaceholder') : t('annotate.commentPlaceholder')}
        autoFocus={card.edit}
        value={text}
        rows={3}
        placeholder={question ? t('annotate.questionPlaceholder') : t('annotate.commentPlaceholder')}
        onChange={(e) => setBody(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            commit()
            useAnnotate.getState().close()
          }
        }}
        className="w-full resize-none rounded-lg border border-border bg-surface px-2.5 py-2 text-sm leading-relaxed text-fg outline-none placeholder:text-subtle focus:border-accent"
      />
      <div className="mt-2 flex items-center gap-1">
        {ANNO_COLORS.map((c) => (
          <button
            key={c}
            aria-label={t(`annotate.colors.${c}`)}
            aria-pressed={(a.color ?? 'yellow') === c}
            onClick={() => {
              rememberColor(c)
              void save({ color: c })
            }}
            className={cn(
              'size-5 rounded-full border border-black/10 transition-transform hover:scale-110',
              (a.color ?? 'yellow') === c && 'ring-2 ring-accent ring-offset-1 ring-offset-[var(--surface)]'
            )}
            style={{ background: SWATCH[c] }}
          />
        ))}
        <span className="flex-1" />
        <Tip label={question ? t('annotate.unmarkQuestion') : t('annotate.markQuestion')}>
          <button
            aria-label={t('annotate.question')}
            aria-pressed={question}
            onClick={() => void save({ motivation: question ? (a.body ? 'commenting' : 'highlighting') : 'questioning' })}
            className={cn(
              'grid size-7 place-items-center rounded-lg text-muted hover:bg-surface-hover hover:text-fg [&_svg]:size-4',
              question && 'text-[#c0663a]'
            )}
          >
            <CircleHelp />
          </button>
        </Tip>
        <Tip label={t('annotate.askAi')}>
          <button
            aria-label={t('annotate.askAi')}
            onClick={() => {
              commit()
              useAnnotate.getState().close()
              useAssist.getState().openCard({ anchor: selectorAnchor(a), rect: r, action: 'ask', conversationId: null, question: '' })
            }}
            className="grid size-7 place-items-center rounded-lg text-muted hover:bg-surface-hover hover:text-fg [&_svg]:size-4"
          >
            <MessageCircleQuestion />
          </button>
        </Tip>
        <Tip label={t('annotate.remove')}>
          <button
            aria-label={t('annotate.remove')}
            onClick={() => void removeAnnotation(a)}
            className="grid size-7 place-items-center rounded-lg text-muted hover:bg-surface-hover hover:text-danger [&_svg]:size-4"
          >
            <Trash2 />
          </button>
        </Tip>
        <button
          aria-label={t('common.close')}
          onClick={() => {
            commit()
            useAnnotate.getState().close()
          }}
          className="grid size-7 place-items-center rounded-lg text-subtle hover:bg-surface-hover hover:text-fg [&_svg]:size-4"
        >
          <X />
        </button>
      </div>
    </div>
  )
}

import { useExpandedPresentation } from '@/components/ui/ExpandableSurface'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { UiNode } from '@shared/ui/catalog'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import type { UiContext } from '../context'
import { ConfirmSheet, uiAction } from '../ConfirmSheet'

type Practice = Extract<UiNode, { type: 'quiz' | 'flashcards' | 'cloze' }>
type Answer = { value: string | number; checked?: boolean }
const position = (value: unknown, length: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < length ? value : 0
const equal = (a: string | number, b: string | number): boolean =>
  String(a).trim().toLocaleLowerCase() === String(b).trim().toLocaleLowerCase()
const questionText = (q: Extract<UiNode, { type: 'quiz' }>['items'][number]): string =>
  [q.q, ...(q.options ?? []).map((o, i) => `${i + 1}. ${o}`)].join('\n')

function PracticeSave({
  node,
  uiKey,
  ctx,
  disabled,
  label
}: {
  node: Practice
  uiKey: string
  ctx: UiContext
  disabled: boolean
  label: string
}) {
  const { runOutside } = useExpandedPresentation()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const saved = ctx.states[uiKey]?.practiceNote as { noteId: string; title: string } | undefined
  const title = node.title ?? t('ui.practiceTitle')
  const items =
    node.type === 'quiz'
      ? node.items.map((q, i) => ({ id: String(i), label: q.q }))
      : node.type === 'flashcards'
        ? node.cards.map((c, i) => ({ id: String(i), label: c.front }))
        : [{ id: '0', label: node.text.replace(/\{\{[^{}]+\}\}/g, '____') }]
  if (ctx.context !== 'chat') return null
  return (
    <div className="mt-3">
      {saved ? (
        <p className="text-xs text-muted">
          {t('ui.done.joined', { title: saved.title })}{' '}
          <button className="text-accent" onClick={() => runOutside(() => useApp.getState().openNote(saved.noteId))}>
            {t('ui.open')}
          </button>
        </p>
      ) : (
        <button className={uiAction} disabled={disabled} onClick={() => setOpen(true)}>
          {label}
        </button>
      )}
      {open && (
        <ConfirmSheet
          items={items}
          target={t('ui.target.newNote', { title })}
          onCancel={() => setOpen(false)}
          onConfirm={async (ids) => {
            if (saved) {
              await ctx.flushState?.(uiKey)
              setOpen(false)
              runOutside(() => useApp.getState().openNote(saved.noteId))
              return
            }
            const selected: Practice =
              node.type === 'quiz'
                ? { ...node, items: node.items.filter((_q, i) => ids.includes(String(i))) }
                : node.type === 'flashcards'
                  ? { ...node, cards: node.cards.filter((_c, i) => ids.includes(String(i))) }
                  : node
            const r = await api.ui.saveToNote({
              conversationId: ctx.conversationId,
              messageId: ctx.messageId,
              uiKey,
              node: selected,
              state: ctx.states[uiKey],
              target: { newTitle: title },
              mode: 'rows'
            })
            ctx.setState(uiKey, { practiceNote: { noteId: r.noteId, title } })
            await ctx.flushState?.(uiKey)
            setOpen(false)
            // auto 提案在真实编辑器中应用，沿用保存回答的撤销/来源路径。
            runOutside(() => useApp.getState().openNote(r.noteId))
            toast.success(t('ui.done.saved', { title }), {
              action: { label: t('ui.open'), onClick: () => runOutside(() => useApp.getState().openNote(r.noteId)) }
            })
          }}
        />
      )}
    </div>
  )
}

export function QuizNode({
  node,
  uiKey,
  ctx,
  disabled
}: {
  node: Extract<UiNode, { type: 'quiz' }>
  uiKey: string
  ctx: UiContext
  disabled: boolean
}) {
  const { t } = useTranslation()
  const [confirm, setConfirm] = useState(false)
  const state = ctx.states[uiKey] ?? {},
    answers = (state.answers ?? {}) as Record<string, Answer>
  const index = position(state.question, node.items.length),
    q = node.items[index],
    current = answers[index]
  const completed = node.items.every((_q, i) => answers[i]?.checked)
  const wrong = node.items.flatMap((q, i) =>
    answers[i]?.checked && !equal(answers[i].value, q.answer) ? [{ id: String(i), label: q.q }] : []
  )
  const written = (state.mistakes ?? {}) as Record<string, string>
  const update = (value: string | number): void => ctx.setState(uiKey, { answers: { ...answers, [index]: { value } } })
  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-2xs text-subtle" aria-live="polite">
        {index + 1} / {node.items.length}
      </p>
      <p className="text-sm">{q.q}</p>
      {q.options ? (
        <div role="radiogroup" aria-label={q.q} className="space-y-2">
          {q.options.map((option, i) => (
            <label
              key={i}
              // 核对后：正确答案标绿，选错的标红，其余淡出
              className={cn(
                'flex gap-2 rounded-lg border border-border p-2 text-sm transition-colors',
                !current?.checked && current?.value === i && 'border-accent bg-accent/5',
                current?.checked && i === q.answer && 'border-viz-8/60 bg-viz-8/10',
                current?.checked && current.value === i && i !== q.answer && 'border-viz-4/60 bg-viz-4/10',
                current?.checked && current.value !== i && i !== q.answer && 'opacity-60'
              )}
            >
              <input
                type="radio"
                name={`${ctx.messageId}-${uiKey}-${index}`}
                aria-label={option}
                disabled={disabled || !!current?.checked}
                checked={current?.value === i}
                onChange={() => update(i)}
                className="accent-accent"
              />
              {option}
            </label>
          ))}
        </div>
      ) : (
        <input
          aria-label={q.q}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          maxLength={2000}
          disabled={disabled || !!current?.checked}
          value={String(current?.value ?? '')}
          onChange={(e) => update(e.target.value)}
        />
      )}
      {!current?.checked ? (
        <button
          className={uiAction}
          disabled={disabled || current?.value === undefined || current.value === ''}
          onClick={() => ctx.setState(uiKey, { answers: { ...answers, [index]: { ...current!, checked: true } } })}
        >
          {t('ui.action.check')}
        </button>
      ) : (
        <div
          role="status"
          className={cn(
            'rounded-lg border-l-[3px] bg-sunken p-3 text-xs',
            equal(current.value, q.answer) ? 'border-viz-8' : 'border-viz-4'
          )}
        >
          <p className={cn('font-medium', equal(current.value, q.answer) ? 'text-viz-8' : 'text-viz-4')}>
            {t(equal(current.value, q.answer) ? 'ui.correct' : 'ui.incorrect')}
          </p>
          <p className="mt-1 whitespace-pre-wrap">
            {t('ui.answer')} {q.options ? q.options[q.answer as number] : q.answer}
          </p>
          <p className="mt-1 whitespace-pre-wrap leading-relaxed text-muted">{q.explain}</p>
        </div>
      )}
      {current?.checked && index < node.items.length - 1 && (
        <button className={uiAction} disabled={disabled} onClick={() => ctx.setState(uiKey, { question: index + 1 })}>
          {t('ui.action.next')}
        </button>
      )}
      {completed && (
        <div className="border-t border-border pt-3">
          {!!wrong.length && ctx.context === 'chat' && (
            <button
              className={uiAction}
              disabled={disabled || ctx.sharedWritesAllowed === false || wrong.every((i) => !!written[i.id])}
              title={ctx.sharedWritesAllowed === false ? t('attach.reason.sharedWrite') : undefined}
              onClick={() => setConfirm(true)}
            >
              {t('ui.action.mistakes')}
            </button>
          )}
          {Object.keys(written).length > 0 && (
            <p className="mt-2 text-xs text-muted">{t('ui.done.mistakes', { n: Object.keys(written).length })}</p>
          )}
          <PracticeSave node={node} uiKey={uiKey} ctx={ctx} disabled={disabled} label={t('ui.action.practiceNote')} />
        </div>
      )}
      {confirm && (
        <ConfirmSheet
          items={wrong.filter((i) => !written[i.id])}
          target={t('ui.target.mistakes')}
          onCancel={() => setConfirm(false)}
          onConfirm={async (ids) => {
            if (!(await api.ui.canShareDerived(ctx.messageId))) throw new Error(t('attach.reason.sharedWrite'))
            const saved = { ...written },
              requests = { ...((state.mistakeRequests ?? {}) as Record<string, string>) }
            for (const id of ids) {
              if (saved[id]) continue
              requests[id] ??= crypto.randomUUID()
              // 在副作用前保存幂等身份，断线/重开后的重试也不会重复录入。
              ctx.setState(uiKey, { mistakeRequests: { ...requests } })
              await ctx.flushState?.(uiKey)
              const item = node.items[Number(id)],
                answer = item.options ? item.options[item.answer as number] : item.answer
              const text = [
                questionText(item),
                `${t('ui.answer')} ${answer}`,
                item.explain,
                `${t('ui.myAnswer')} ${item.options ? item.options[answers[id].value as number] : answers[id].value}`
              ].join('\n\n')
              const result = await api.mistakes.create({
                sourceKind: 'manual',
                sourceRef: `${ctx.conversationId}:${ctx.messageId}:${uiKey}`,
                text,
                requestId: requests[id]
              })
              if (!result.items[0]) throw new Error(t('ui.failed'))
              saved[id] = result.items[0].id
              ctx.setState(uiKey, { mistakes: { ...saved } })
              await ctx.flushState?.(uiKey)
            }
            setConfirm(false)
          }}
        />
      )}
    </div>
  )
}

export function FlashcardsNode({
  node,
  uiKey,
  ctx,
  disabled
}: {
  node: Extract<UiNode, { type: 'flashcards' }>
  uiKey: string
  ctx: UiContext
  disabled: boolean
}) {
  const { t } = useTranslation()
  const state = ctx.states[uiKey] ?? {},
    index = position(state.card, node.cards.length),
    flipped = !!state.flipped
  return (
    <div className="px-4 py-3">
      <p className="mb-2 text-2xs text-subtle">
        {index + 1} / {node.cards.length}
      </p>
      <button
        type="button"
        aria-label={t('ui.flip')}
        aria-pressed={flipped}
        disabled={disabled}
        // 正面中性底色，背面换成藤紫浅底，翻面前后一眼能分清
        className={cn(
          'min-h-36 w-full rounded-xl border p-5 text-left text-sm leading-relaxed whitespace-pre-wrap transition-colors focus:ring-2 focus:ring-accent',
          flipped ? 'border-viz-5/40 bg-viz-5/10' : 'border-border bg-sunken'
        )}
        onClick={() => ctx.setState(uiKey, { flipped: !flipped })}
      >
        {flipped ? node.cards[index].back : node.cards[index].front}
      </button>
      <div className="mt-3 flex gap-2">
        <button
          className={uiAction}
          disabled={disabled || index === 0}
          onClick={() => ctx.setState(uiKey, { card: index - 1, flipped: false })}
        >
          {t('ui.previous')}
        </button>
        <button
          className={uiAction}
          disabled={disabled || index === node.cards.length - 1}
          onClick={() => ctx.setState(uiKey, { card: index + 1, flipped: false })}
        >
          {t('ui.nextCard')}
        </button>
      </div>
      <PracticeSave node={node} uiKey={uiKey} ctx={ctx} disabled={disabled} label={t('ui.action.review')} />
    </div>
  )
}

export function ClozeNode({
  node,
  uiKey,
  ctx,
  disabled
}: {
  node: Extract<UiNode, { type: 'cloze' }>
  uiKey: string
  ctx: UiContext
  disabled: boolean
}) {
  const { t } = useTranslation()
  const blanks = [...node.text.matchAll(/\{\{([^{}]+)\}\}/g)],
    parts = node.text.split(/\{\{[^{}]+\}\}/g)
  const state = ctx.states[uiKey] ?? {},
    values = (state.values ?? {}) as Record<string, string>,
    checked = !!state.checked
  return (
    <div className="px-4 py-3">
      <div className="text-sm leading-loose">
        {parts.map((part, i) => (
          <span key={i}>
            {part}
            {blanks[i] && (
              <span className="inline-flex flex-col align-middle">
                <input
                  aria-label={t('ui.blank', { n: i + 1 })}
                  className="mx-1 w-28 rounded border border-border bg-surface px-2 text-sm"
                  maxLength={200}
                  disabled={disabled}
                  value={values[i] ?? ''}
                  onChange={(e) => ctx.setState(uiKey, { values: { ...values, [i]: e.target.value }, checked: false })}
                />
                {checked && (
                  <small className={equal(values[i] ?? '', blanks[i][1]) ? 'text-center text-viz-8' : 'text-center text-viz-4'}>
                    {t(equal(values[i] ?? '', blanks[i][1]) ? 'ui.correct' : 'ui.incorrect')}
                  </small>
                )}
              </span>
            )}
          </span>
        ))}
      </div>
      <button
        className={cn(uiAction, 'mt-3')}
        disabled={disabled || blanks.some((_b, i) => !values[i]?.trim())}
        onClick={() => ctx.setState(uiKey, { checked: true })}
      >
        {t('ui.action.check')}
      </button>
      {checked && node.explain && <p className="mt-2 text-xs leading-relaxed whitespace-pre-wrap text-muted">{node.explain}</p>}
      <PracticeSave node={node} uiKey={uiKey} ctx={ctx} disabled={disabled} label={t('ui.action.review')} />
    </div>
  )
}

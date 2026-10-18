import { useExpandedPresentation } from '@/components/ui/ExpandableSurface'
import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { UiNode } from '@shared/ui/catalog'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import type { UiContext } from './context'
import { ConfirmSheet, uiAction } from './ConfirmSheet'

const dataTypes = new Set(['schedule', 'tasks', 'note', 'excerpt', 'mastery', 'decision', 'usage'])
export function SaveToNote({ node, uiKey, ctx, onClose }: { node: UiNode; uiKey: string; ctx: UiContext; onClose(): void }) {
  const { runOutside } = useExpandedPresentation()
  const { t } = useTranslation()
  const [search, setSearch] = useState(''),
    [target, setTarget] = useState<{ noteId?: string; newTitle?: string; title: string } | null>(null)
  const written = useRef<{ noteId: string; title: string } | null>(null)
  const { data: notes = [] } = useQuery({
    queryKey: ['ui-note-targets', search],
    // 既有列表先置顶再截断；目标弹层需先排除不可用项、按编辑时间排序，再取八篇。
    queryFn: () => api.notes.list({ search, sort: 'edited' })
  })
  const { data: conversations = [] } = useQuery({ queryKey: ['conversations'], queryFn: () => api.chat.conversations() })
  const title = node.title ?? conversations.find((c) => c.id === ctx.conversationId)?.title ?? t('common.untitled')
  return (
    <div className="m-3 rounded-lg border border-border bg-surface p-3">
      {!target ? (
        <div data-testid="ui-save-target" className="space-y-2">
          <button className={uiAction} onClick={() => setTarget({ newTitle: title, title })}>
            {t('ui.newNote')}
          </button>
          <input
            aria-label={t('ui.searchNotes')}
            placeholder={t('ui.searchNotes')}
            className="block w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {notes
            .filter((n) => n.deletedAt === null && !n.aiExcluded)
            .sort((a, b) => b.editedAt - a.editedAt)
            .slice(0, 8)
            .map((note) => (
              <button
                key={note.id}
                className="block w-full rounded p-2 text-left text-xs hover:bg-sunken"
                onClick={() => setTarget({ noteId: note.id, title: note.title })}
              >
                {note.title}
              </button>
            ))}
          <button className={uiAction} onClick={onClose}>
            {t('ui.confirm.cancel')}
          </button>
        </div>
      ) : (
        <ConfirmSheet
          items={[{ id: 'node', label: node.title ?? title }]}
          target={t(target.noteId ? 'ui.target.appendNote' : 'ui.target.newNote', { title: target.title })}
          onCancel={onClose}
          onConfirm={async () => {
            if (!written.current) {
              const state = {
                ...ctx.states[uiKey],
                descendants: Object.fromEntries(
                  Object.entries(ctx.states)
                    .filter(([key]) => key.startsWith(`${uiKey}.`))
                    .map(([key, value]) => [key.slice(uiKey.length + 1), value])
                )
              }
              if (dataTypes.has(node.type)) Object.assign(state, { snapshot: ctx.snapshot?.(uiKey) ?? '' })
              const r = await api.ui.saveToNote({
                conversationId: ctx.conversationId,
                messageId: ctx.messageId,
                uiKey,
                node,
                state,
                target: { noteId: target.noteId, newTitle: target.newTitle },
                mode: 'auto'
              })
              written.current = { noteId: r.noteId, title: target.title }
            }
            await ctx.flushState?.(uiKey)
            runOutside(() => useApp.getState().openNote(written.current!.noteId))
            toast.success(t('ui.done.saved', { title: written.current.title }), {
              action: { label: t('ui.open'), onClick: () => runOutside(() => useApp.getState().openNote(written.current!.noteId)) }
            })
            onClose()
          }}
        />
      )}
    </div>
  )
}

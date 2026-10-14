import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Paperclip } from 'lucide-react'
import { useCategories } from '@/lib/queries'
import { api, formatDate } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/primitives'
import { useProvidePageContext } from '../assist/pageContext'
import { AttachmentIcon, openAttachment, formatAttachmentSize } from './AttachmentBar'
import { ArchiveAttachmentsDialog, deleteAttachmentRows, useAttachmentEvents } from './ConversationAttachments'
import { setLibraryFilter } from '../library/state'
import { errText } from '../chat/useChat'

export function AttachmentSpaceView() {
  const { t, i18n } = useTranslation(),
    [state, setState] = useState<'unarchived' | 'archived' | 'all'>('unarchived'),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [archive, setArchive] = useState<string[]>([])
  useAttachmentEvents()
  // 管理界面的文件名和来源列表不能变成侧栏AI的隐式页面上下文。
  useProvidePageContext(null)
  const { data: items = [], isFetched } = useQuery({
    queryKey: ['attachment-space', state, query],
    queryFn: () => api.attachments.list({ state, query })
  })
  const { data: categories = [] } = useCategories('source')
  const active = selected.filter((id) => items.some((a) => a.sourceId === id)),
    all = !!items.length && active.length === items.length
  const remove = async (ids: string[]) => {
    try {
      await deleteAttachmentRows(ids)
      setSelected([])
    } catch (e) {
      toast.error(errText(e))
    }
  }
  return (
    <section data-testid="attachment-space" className="flex h-full min-h-0 flex-col">
      <header className="drag shrink-0 border-b border-border px-6 pt-4 pb-3">
        <h2 className="font-serif text-lg font-semibold text-fg">{t('attach.space.title')}</h2>
        <p className="no-drag mt-2 max-w-3xl text-xs leading-relaxed text-muted">{t('attach.space.intro')}</p>
        <div className="no-drag mt-4 flex flex-wrap gap-3">
          <div className="flex rounded-lg bg-sunken p-1">
            {(['unarchived', 'archived', 'all'] as const).map((s) => (
              <button
                key={s}
                aria-pressed={s === state}
                className={`rounded-md px-3 py-1 text-xs ${state === s ? 'bg-surface text-fg' : 'text-muted'}`}
                onClick={() => {
                  setState(s)
                  setSelected([])
                }}
              >
                {t('attach.space.filter.' + s)}
              </button>
            ))}
          </div>
          <Input
            className="max-w-xs"
            aria-label={t('attach.search')}
            placeholder={t('attach.search')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected([])
            }}
          />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-4">
        {isFetched && !items.length ? (
          <div className="grid min-h-60 place-items-center text-center text-muted">
            <div>
              <Paperclip className="mx-auto mb-4 size-12 text-subtle" />
              <p className="max-w-md text-sm">{t('attach.space.empty')}</p>
            </div>
          </div>
        ) : (
          <table className="w-full min-w-[700px] text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-3 pr-2">
                  <input
                    type="checkbox"
                    aria-label={t('attach.space.selectAll')}
                    checked={all}
                    onChange={(e) => setSelected(e.target.checked ? items.map((a) => a.sourceId) : [])}
                  />
                </th>
                {['name', 'from', 'added', 'size', 'state'].map((k) => (
                  <th className="px-2 py-3 font-normal" key={k}>
                    {t('attach.space.' + k)}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.sourceId} data-testid="attachment-space-row" data-source-id={a.sourceId} className="border-t border-border/70">
                  <td className="py-3 pr-2">
                    <input
                      type="checkbox"
                      aria-label={`${t('attach.space.select')} ${a.name}`}
                      checked={active.includes(a.sourceId)}
                      onChange={(e) => setSelected((xs) => (e.target.checked ? [...xs, a.sourceId] : xs.filter((id) => id !== a.sourceId)))}
                    />
                  </td>
                  <td className="max-w-72 px-2">
                    <button className="flex max-w-full items-center gap-2 text-left text-fg" onClick={() => openAttachment(a)}>
                      <AttachmentIcon a={a} />
                      <span className="truncate" title={a.name}>
                        {a.name}
                      </span>
                    </button>
                  </td>
                  <td className="max-w-48 px-2">
                    {a.conversations.length ? (
                      a.conversations.map((c) => (
                        <button
                          key={c.id}
                          className="block max-w-full truncate py-1 text-accent"
                          onClick={() => {
                            void api.chat.conversations().then((cs) => {
                              if (cs.some((x) => x.id === c.id)) useApp.getState().openConversation(c.id)
                              else {
                                useApp.getState().navigate({ view: 'advisor' })
                                useApp.setState({ decisionId: c.id })
                              }
                            })
                          }}
                        >
                          {c.title || t('common.untitled')}
                        </button>
                      ))
                    ) : (
                      <span className="text-muted">{t('attach.orphan')}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 text-muted">{formatDate(a.createdAt, i18n.language)}</td>
                  <td className="whitespace-nowrap px-2 text-muted">{formatAttachmentSize(a.size)}</td>
                  <td className="px-2 text-muted">
                    {a.space === 'attachment'
                      ? t('attach.space.filter.unarchived')
                      : a.archivedCategoryId
                        ? t('attach.archivedTo', {
                            category: categories.find((c) => c.id === a.archivedCategoryId)?.name ?? t('attach.uncategorized')
                          })
                        : t('attach.archived')}
                  </td>
                  <td>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openAttachment(a)}>
                        {t('attach.preview')}
                      </Button>
                      {a.space === 'attachment' && (
                        <Button size="sm" variant="ghost" onClick={() => setArchive([a.sourceId])}>
                          {t('attach.archive')}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => void remove([a.sourceId])}>
                        {t('attach.delete')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!!active.length && (
        <div
          data-testid="attachment-space-actions"
          className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-6 py-3"
        >
          <span className="mr-auto text-sm text-muted">{active.length}</span>
          <Button onClick={() => setArchive(active)}>{t('attach.archiveTo')}</Button>
          <Button onClick={() => void remove(active)}>{t('attach.delete')}</Button>
        </div>
      )}
      {!!archive.length && (
        <ArchiveAttachmentsDialog
          ids={archive}
          onClose={() => setArchive([])}
          onArchived={(categoryId) => {
            const n = archive.length
            setSelected([])
            toast.success(t('attach.space.archivedToast', { n }), {
              action: {
                label: t('attach.view'),
                onClick: () =>
                  setLibraryFilter({
                    attachmentSpace: false,
                    kind: undefined,
                    search: '',
                    cat: categoryId ? { type: 'category', id: categoryId } : { type: 'uncategorized' }
                  })
              }
            })
          }}
        />
      )}
    </section>
  )
}

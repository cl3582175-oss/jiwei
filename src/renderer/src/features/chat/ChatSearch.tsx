import { useEffect, useRef, useState } from 'react'
import { Dialog as D } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import type { ChatSearchHit } from '@shared/chatProjects'
import { api, cn, formatRelative } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'

export function ChatSearch({ close }: { close: () => void }) {
  const { t, i18n } = useTranslation()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ChatSearchHit[]>([])
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    setHits([])
    setSelected(0)
    setFailed(false)
    const q = query.trim()
    setBusy(!!q)
    if (!q) return
    const timer = setTimeout(() => {
      void api.chat
        .search(q)
        .then(
          (result) => {
            if (!cancelled) setHits(result.slice(0, 50))
          },
          () => {
            if (!cancelled) setFailed(true)
          }
        )
        .finally(() => {
          if (!cancelled) setBusy(false)
        })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])
  useEffect(() => {
    list.current?.querySelector(`[data-hit-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  const open = (hit: ChatSearchHit): void => {
    useApp.getState().openConversation(hit.conversationId, hit.messageId)
    close()
  }
  return (
    <D.Root open onOpenChange={(value) => !value && close()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <D.Content className="fixed top-[16vh] left-1/2 z-50 w-[min(92vw,660px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-float outline-none">
          <D.Title className="sr-only">{t('projects.search')}</D.Title>
          <D.Description className="sr-only">{t('projects.searchHint')}</D.Description>
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Search className="size-4 shrink-0 text-muted" />
            <input
              autoFocus
              value={query}
              maxLength={200}
              aria-label={t('projects.search')}
              placeholder={t('projects.searchHint')}
              className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-subtle"
              role="combobox"
              aria-controls="chat-search-results"
              aria-expanded={hits.length > 0}
              aria-activedescendant={hits[selected] ? `chat-search-hit-${selected}` : undefined}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSelected((i) => (hits.length ? (i + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length : 0))
                } else if (e.key === 'Enter' && hits[selected]) {
                  e.preventDefault()
                  open(hits[selected])
                }
              }}
            />
            <Tip label={t('projects.close')}>
              <Button variant="ghost" size="icon-sm" aria-label={t('projects.close')} onClick={close}>
                <X />
              </Button>
            </Tip>
          </div>
          <div
            ref={list}
            id="chat-search-results"
            role="listbox"
            aria-label={t('projects.searchResults')}
            className="max-h-[55vh] overflow-y-auto p-2"
          >
            {hits.map((hit, index) => (
              <button
                key={`${hit.conversationId}:${hit.messageId ?? 'title'}`}
                id={`chat-search-hit-${index}`}
                role="option"
                aria-selected={selected === index}
                data-hit-index={index}
                onMouseMove={() => setSelected(index)}
                onClick={() => open(hit)}
                className={cn(
                  'block w-full rounded-xl px-3 py-3 text-left outline-none',
                  selected === index ? 'bg-accent-soft/60' : 'hover:bg-surface-hover'
                )}
              >
                <span className="block truncate text-sm font-medium text-fg">{hit.title || t('common.untitled')}</span>
                <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-muted">{hit.snippet}</span>
                <span className="mt-1.5 flex items-center gap-2 text-2xs text-subtle">
                  <span className="truncate">{hit.projectName ?? t('projects.recent')}</span>
                  <span>·</span>
                  <span className="shrink-0">{formatRelative(hit.lastMessageAt, i18n.language)}</span>
                </span>
              </button>
            ))}
            {hits.length === 0 && (
              <p role="status" className="px-4 py-10 text-center text-xs text-subtle">
                {t(
                  failed
                    ? 'projects.searchFailed'
                    : busy
                      ? 'projects.searching'
                      : query.trim()
                        ? 'projects.noResults'
                        : 'projects.searchHint'
                )}
              </p>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

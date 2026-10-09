import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { Extension, type Editor, type Range } from '@tiptap/core'
import { ReactRenderer } from '@tiptap/react'
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { NotebookText, FileText, Plus } from 'lucide-react'
import i18n from 'i18next'
import { api, cn } from '@/lib/utils'

// [[ 链接（v0.5.0）：输入 [[ 搜索笔记与资料，选中后插入带应用内链接的标题；找不到时可以新建一篇并链接过去。
// 基于 Tiptap 官方的 Suggestion 工具；链接本身仍是普通的 link 标记（jiwei://note/<id>），派生时写入 links 表。

export interface LinkItem {
  type: 'note' | 'source' | 'new'
  id: string
  title: string
  hint?: string
}

async function search(query: string, selfId: string): Promise<LinkItem[]> {
  const q = query.trim()
  const [notes, sources] = await Promise.all([
    api.notes.list({ search: q || undefined, limit: 8, sort: 'edited' }),
    q ? api.sources.list({ search: q }) : Promise.resolve([])
  ])
  const items: LinkItem[] = [
    ...notes.filter((n) => n.id !== selfId && n.kind === 'cornell').slice(0, 7).map((n) => ({ type: 'note' as const, id: n.id, title: n.title || i18n.t('common.untitled'), hint: n.excerpt.slice(0, 40) })),
    ...sources.slice(0, 4).map((s) => ({ type: 'source' as const, id: s.id, title: s.title }))
  ]
  if (q && !notes.some((n) => n.title.trim() === q)) items.push({ type: 'new', id: '', title: q })
  return items
}

interface ListProps {
  items: LinkItem[]
  command: (item: LinkItem) => void
}
export interface ListHandle {
  onKeyDown: (p: SuggestionKeyDownProps) => boolean
}

const List = forwardRef<ListHandle, ListProps>(function List({ items, command }, ref) {
  const [i, setI] = useState(0)
  useEffect(() => setI(0), [items])
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') {
        setI((x) => (x + 1) % Math.max(1, items.length))
        return true
      }
      if (event.key === 'ArrowUp') {
        setI((x) => (x - 1 + items.length) % Math.max(1, items.length))
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (items[i]) command(items[i])
        return true
      }
      return false
    }
  }))
  return (
    <div role="listbox" aria-label={i18n.t('links.pickerLabel')} className="w-72 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-float">
      {items.length === 0 ? (
        <p className="px-3 py-2 text-xs text-subtle">{i18n.t('links.pickerEmpty')}</p>
      ) : (
        items.map((it, j) => (
          <button
            key={`${it.type}:${it.id}:${it.title}`}
            role="option"
            aria-selected={j === i}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setI(j)}
            onClick={() => command(it)}
            className={cn('flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0', j === i ? 'bg-accent-soft' : '')}
          >
            {it.type === 'note' ? <NotebookText className="text-accent" /> : it.type === 'source' ? <FileText className="text-muted" /> : <Plus className="text-accent" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-fg">{it.type === 'new' ? i18n.t('links.createNote', { title: it.title }) : it.title}</span>
              {it.hint && <span className="block truncate text-2xs text-subtle">{it.hint}</span>}
            </span>
          </button>
        ))
      )}
    </div>
  )
})

/** 插入链接；不加空格（中文不需要），并去掉光标处的链接格式，接着输入的文字不会并进链接 */
function insertLink(editor: Editor, range: Range, href: string, title: string): void {
  editor
    .chain()
    .focus()
    .insertContentAt(range, { type: 'text', text: title, marks: [{ type: 'link', attrs: { href } }] })
    .unsetMark('link')
    .run()
}

export const WikiLink = Extension.create<{ noteId: string }>({
  name: 'wikiLink',
  addOptions: () => ({ noteId: '' }),
  addProseMirrorPlugins() {
    const selfId = this.options.noteId
    return [
      Suggestion<LinkItem, LinkItem>({
        editor: this.editor,
        pluginKey: new PluginKey('wikiLink'),
        char: '[[',
        allowSpaces: true,
        // 中文前面通常没有空格：任何字符后都可以触发
        allowedPrefixes: null,
        items: ({ query }) => search(query, selfId),
        command: ({ editor, range, props: it }) => {
          if (it.type === 'new') {
            // 新建一篇笔记并链接过去（不离开当前笔记）
            void api.notes.create({ title: it.title }).then((n) => insertLink(editor, range, `jiwei://note/${n.id}`, it.title))
            return
          }
          insertLink(editor, range, `jiwei://${it.type}/${it.id}`, it.title)
        },
        render: () => {
          let r: ReactRenderer<ListHandle, ListProps> | null = null
          let el: HTMLDivElement | null = null
          const place = (p: SuggestionProps<LinkItem, LinkItem>): void => {
            const rect = p.clientRect?.()
            if (!el || !rect) return
            el.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`
            el.style.top = `${rect.bottom + 6}px`
          }
          return {
            onStart: (p) => {
              r = new ReactRenderer(List, { props: { items: p.items, command: p.command }, editor: p.editor })
              el = document.createElement('div')
              el.className = 'fixed z-50'
              el.appendChild(r.element)
              document.body.appendChild(el)
              place(p)
            },
            onUpdate: (p) => {
              r?.updateProps({ items: p.items, command: p.command })
              place(p)
            },
            onKeyDown: (p) => {
              if (p.event.key === 'Escape') {
                el?.remove()
                return true
              }
              return r?.ref?.onKeyDown(p) ?? false
            },
            onExit: () => {
              el?.remove()
              r?.destroy()
              el = null
              r = null
            }
          }
        }
      })
    ]
  }
})

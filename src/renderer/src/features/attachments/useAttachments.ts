import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Attachment } from '@shared/types'
import { CODE_EXTS } from '@shared/attachments'
import { api } from '@/lib/utils'
import { errText } from '../chat/useChat'

export interface AttachmentTarget {
  kind: 'chat' | 'workspace' | 'inline' | 'advisor'
  conversationId?: string | null
  incognito?: boolean
}
export interface AttachmentsController {
  items: Attachment[]
  adding: boolean
  ids: () => string[]
  clear: (ids: string[]) => void
  pick: () => Promise<void>
  addFiles: (files: File[]) => Promise<void>
  remove: (id: string) => void
  reference: (id: string) => Promise<void>
  paste: (e: React.ClipboardEvent) => void
  mention: boolean
  mentionQuery: string
  textChanged: (text: string) => void
  closeMention: () => void
}
const unfinished = (a: Attachment) => ['adding', 'parsing', 'recognizing', 'transcribing'].includes(a.status)
const inlineExts = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'txt', 'md', 'markdown', 'html', 'htm', ...CODE_EXTS])
const extension = (name: string) => name.split('.').at(-1)?.toLowerCase() ?? ''
const RESET_EVENT = 'jiwei:attachment-draft-reset'
export function resetAttachmentDraft(kind: AttachmentTarget['kind']): void {
  window.dispatchEvent(new CustomEvent(RESET_EVENT, { detail: kind }))
}
export function useAttachments(target: AttachmentTarget): AttachmentsController {
  const { t } = useTranslation(),
    key = JSON.stringify(target),
    current = useRef(key),
    generation = useRef(0)
  // 异步回包携带世代；切换会话后旧上传结果不能落进新输入框。
  if (current.current !== key) {
    current.current = key
    generation.current++
  }
  const [state, setState] = useState<{ key: string; items: Attachment[] }>({ key, items: [] })
  const [mention, setMention] = useState(false),
    [mentionQuery, setMentionQuery] = useState('')
  const items = state.key === key ? state.items : [],
    live = useRef(items)
  live.current = items
  const update = (fn: (xs: Attachment[]) => Attachment[]) => setState((s) => ({ key, items: fn(s.key === key ? s.items : []) }))
  useEffect(() => {
    const reset = (e: Event) => {
      if ((e as CustomEvent).detail === target.kind) {
        generation.current++
        live.current = []
        setState({ key: current.current, items: [] })
        setMention(false)
      }
    }
    window.addEventListener(RESET_EVENT, reset)
    return () => window.removeEventListener(RESET_EVENT, reset)
  }, [target.kind])
  useEffect(() => {
    setMention(false)
  }, [key])
  useEffect(() => {
    if (!items.some(unfinished)) return
    const version = generation.current
    let stopped = false
    const timer = setInterval(() => {
      const ids = live.current.filter((a) => unfinished(a) && a.status !== 'adding').map((a) => a.sourceId)
      if (!ids.length) return
      void api.attachments
        .status(ids)
        .then(async (rows) => {
          if (target.kind === 'inline')
            for (const a of rows)
              if (a.status === 'ready' && a.kind !== 'image') {
                const segs = await api.segments.list(a.sourceId)
                if (segs.reduce((n, s) => n + s.text.length, 0) > 12000) {
                  a.status = 'unsupported'
                  a.error = t('attach.reason.inlineOnly')
                }
              }
          if (!stopped && version === generation.current) update((xs) => xs.map((a) => rows.find((r) => r.sourceId === a.sourceId) ?? a))
        })
        .catch(() => {})
    }, 1000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
    // 当前条目变化重建定时器；最终状态后停止，不在后台无限轮询。
  }, [key, items, target.kind, t]) // eslint-disable-line react-hooks/exhaustive-deps
  const placeholder = (name: string, size: number, status: Attachment['status'] = 'adding', error: string | null = null): Attachment => ({
    sourceId: crypto.randomUUID(),
    name,
    size,
    kind: 'document',
    mime: null,
    thumbUrl: null,
    status,
    progress: null,
    error,
    space: 'attachment',
    archivedCategoryId: null,
    deleted: false,
    conversations: [],
    createdAt: Date.now()
  })
  const add = async (files: { name: string; size: number; path?: string; file?: File }[]) => {
    const version = generation.current,
      max = target.kind === 'advisor' ? 5 : 10
    const available = max - live.current.length
    if (files.length > available) toast.error(t(target.kind === 'advisor' ? 'attach.reason.advisorTooMany' : 'attach.reason.tooMany'))
    const accepted = files.slice(0, Math.max(0, available)),
      entries = accepted.map((f) => placeholder(f.name, f.size))
    update((xs) => [...xs, ...entries])
    live.current = [...live.current, ...entries]
    for (let i = 0; i < accepted.length; i++) {
      const f = accepted[i],
        temp = entries[i]
      try {
        if (target.kind === 'inline' && !inlineExts.has(extension(f.name))) {
          temp.status = 'unsupported'
          temp.error = t('attach.reason.inlineOnly')
          if (version === generation.current) update((xs) => xs.map((a) => (a.sourceId === temp.sourceId ? { ...temp } : a)))
          continue
        }
        const rows = await api.attachments.add({
          ...(f.path ? { paths: [f.path] } : { files: [{ name: f.name, data: new Uint8Array(await f.file!.arrayBuffer()) }] }),
          conversationId: target.conversationId ?? null,
          incognito: target.incognito
        })
        if (version === generation.current)
          update((xs) => {
            const row = rows[0]
            if (!row) return xs.filter((a) => a.sourceId !== temp.sourceId)
            return xs.some((a) => a.sourceId === row.sourceId)
              ? xs.filter((a) => a.sourceId !== temp.sourceId)
              : xs.map((a) => (a.sourceId === temp.sourceId ? row : a))
          })
      } catch (e) {
        if (version === generation.current)
          update((xs) => xs.map((a) => (a.sourceId === temp.sourceId ? { ...temp, status: 'failed', error: errText(e) } : a)))
      }
    }
  }
  const addFiles = async (files: File[]) =>
    add(files.map((file) => ({ name: file.name, size: file.size, path: window.platform.pathForFile(file) || undefined, file })))
  const pick = async () => {
    const version = generation.current,
      paths = await api.attachments.pick()
    if (version === generation.current) await add(paths.map((path) => ({ name: path.split(/[\\/]/).at(-1) ?? path, size: 0, path })))
  }
  const reference = async (id: string) => {
    const version = generation.current
    const entity = id.startsWith('note:') ? await api.notes.get(id.slice(5)) : await api.sources.get(id)
    if (!entity || entity.aiExcluded) {
      toast.error(t('attach.reason.aiExcluded'))
      return
    }
    const max = target.kind === 'advisor' ? 5 : 10
    if (live.current.length >= max) {
      toast.error(t(target.kind === 'advisor' ? 'attach.reason.advisorTooMany' : 'attach.reason.tooMany'))
      return
    }
    const [a] = await api.attachments.status([id])
    if (a && version === generation.current) update((xs) => (xs.some((x) => x.sourceId === id) ? xs : [...xs, a]))
    setMention(false)
  }
  return {
    items,
    adding: items.some((a) => a.status === 'adding'),
    ids: () => live.current.filter((a) => !a.deleted && !['adding', 'failed', 'unsupported'].includes(a.status)).map((a) => a.sourceId),
    clear: (ids) => update((xs) => xs.filter((a) => !ids.includes(a.sourceId))),
    pick,
    addFiles,
    reference,
    remove: (id) => {
      update((xs) => xs.filter((a) => a.sourceId !== id))
      if (target.conversationId && live.current.some((a) => a.sourceId === id && !['adding', 'unsupported', 'failed'].includes(a.status)))
        void api.attachments.removeFromConversation(target.conversationId, id).catch((e) => toast.error(errText(e)))
    },
    paste: (e) => {
      if (e.clipboardData.files.length) {
        e.preventDefault()
        void addFiles(Array.from(e.clipboardData.files))
      }
    },
    mention,
    mentionQuery,
    textChanged: (text) => {
      const match = text.match(/(?:^|\s)@([^\s@]*)$/)
      setMention(!!match)
      setMentionQuery(match?.[1] ?? '')
    },
    closeMention: () => setMention(false)
  }
}

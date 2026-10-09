import { takeInboxDocument } from '../../inbox/documents'
import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { api } from '@/lib/utils'

const PUSH_DELAY = 400
const REMOTE = 'remote'

/**
 * 加载笔记的 Yjs 文档，并把本地编辑以增量形式推送到主进程。
 * 退出、切换笔记、窗口关闭前都会立即推送剩余增量。
 */
export function useNoteDoc(noteId: string): { ydoc: Y.Doc | null; saving: boolean } {
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null)
  const [saving, setSaving] = useState(false)
  const pending = useRef<Uint8Array[]>([])
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    let disposed = false
    const doc = takeInboxDocument(noteId) ?? new Y.Doc()

    const push = async (): Promise<void> => {
      window.clearTimeout(timer.current)
      if (pending.current.length === 0) return
      const update = pending.current.length === 1 ? pending.current[0] : Y.mergeUpdates(pending.current)
      pending.current = []
      try {
        await api.notes.pushUpdate(noteId, update)
      } catch (e) {
        // 推送失败：放回队列，下一次编辑时重试
        pending.current.unshift(update)
        console.error('[doc] push failed', e)
      } finally {
        if (pending.current.length === 0) setSaving(false)
      }
    }

    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === REMOTE) return
      pending.current.push(update)
      setSaving(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void push(), PUSH_DELAY)
    }

    void api.notes.loadDoc(noteId).then((state) => {
      if (disposed) return
      Y.applyUpdate(doc, state, REMOTE)
      doc.on('update', onUpdate)
      setYdoc(doc)
    })

    const offRemote = window.jiweiEvents.on('docs:updated', ({ noteId: id, update }) => { if (id === noteId) Y.applyUpdate(doc, update, REMOTE) })
    const offFlush = window.jiweiEvents.on('app:flush', () => {
      void push().finally(() => void api.app.flushDone())
    })
    const onUnload = (): void => void push()
    window.addEventListener('beforeunload', onUnload)

    return () => {
      disposed = true
      offRemote()
      offFlush()
      window.removeEventListener('beforeunload', onUnload)
      void push().finally(() => doc.destroy())
      doc.off('update', onUpdate)
      setYdoc(null)
    }
  }, [noteId])

  return { ydoc, saving }
}

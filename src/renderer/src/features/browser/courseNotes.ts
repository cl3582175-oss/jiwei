import { useRecording, recordingElapsed } from '../recording/store'
import type { Editor } from '@tiptap/react'
import type { Transaction } from '@tiptap/pm/state'
import { TextSelection } from '@tiptap/pm/state'
import { getMarkRange } from '@tiptap/core'
import { fmtTime } from '@shared/context'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { aiAllowed } from './store'

/** 捕获按下按钮或新增行那一刻的时间，异步保存网页不能把时间点漂移到后来。 */
async function timestamp(automatic: boolean, noteId: string): Promise<{ href: string; text: string } | null> {
  const recording = useRecording.getState().current
  if (recording?.noteId === noteId && (!automatic || recording.status === 'recording')) {
    const at = Math.floor(recordingElapsed() / 1000)
    return { href: `jiwei://source/${recording.sourceId ?? recording.id}?t=${at}`, text: `▶ ${fmtTime(at)}` }
  }
  if (!useApp.getState().browserOpen) return null
  // browser:state 向界面广播有50ms节流，快捷键必须读主进程的新状态，不能误用刚跳转前的时间。
  const state = await api.browser.state()
  const tab = state.tabs.find((t) => t.id === state.activeId) ?? null
  if (!aiAllowed(tab) || !tab.video || Date.now() - tab.video.updatedAt > 10000 || (automatic && tab.video.paused)) return null
  const at = Math.floor(tab.video.currentTime)
  if (automatic && (await api.settings.get()).browser?.course?.autoTimestamp === false) return null
  const sourceId = tab.sourceId ?? (await api.browser.saveSource(tab.id))
  const fresh = (await api.browser.state()).tabs.find((t) => t.id === tab.id)
  if (!fresh || !aiAllowed(fresh) || fresh.url !== tab.url || fresh.video?.mediaId !== tab.video.mediaId) return null
  return { href: `jiwei://source/${sourceId}?t=${at}`, text: `▶ ${fmtTime(at)}` }
}

export function requestTimestamp(): void {
  window.dispatchEvent(new Event('course:insert-time'))
}

/** 手动插入使用映射后的原选区；新增行使用固定行 ID，防止慢 IPC 写错光标或笔记。 */
export async function insertCourseTimestamp(editor: Editor, noteId: string, rowId?: string): Promise<void> {
  let bookmark = editor.state.selection.getBookmark()
  const map = ({ transaction }: { transaction: Transaction }): void => {
    bookmark = bookmark.map(transaction.mapping)
  }
  editor.on('transaction', map)
  try {
    const link = await timestamp(!!rowId, noteId)
    if (!link || editor.isDestroyed || useApp.getState().noteId !== noteId) return
    const { state } = editor
    const text = state.schema.text(link.text, [state.schema.marks.link.create({ href: link.href })])
    let tr = state.tr
    if (rowId) {
      let pos: number | null = null
      state.doc.descendants((node, at) => {
        if (node.type.name === 'cornellRow' && node.attrs.id === rowId) {
          pos = at + 1 + node.child(0).nodeSize + 2
          return false
        }
        return pos === null
      })
      if (pos === null) return
      tr = tr.insert(pos, [text, state.schema.text(' ')])
    } else {
      tr = tr.setSelection(bookmark.resolve(state.doc))
      const mark = tr.selection.$from.marks().find((m) => m.type.name === 'link' && String(m.attrs.href).startsWith('jiwei://source/'))
      const range = mark && getMarkRange(tr.selection.$from, state.schema.marks.link, { href: mark.attrs.href })
      // 光标落在旧时间点内时保留整条出处，避免把一个可点击时间点切成两半。
      if (tr.selection.empty && range) tr = tr.setSelection(TextSelection.create(tr.doc, range.to)).insert(range.to, state.schema.text(' '))
      tr = tr.replaceSelectionWith(text, false)
      tr = tr.insertText(' ')
    }
    editor.view.dispatch(tr.scrollIntoView())
    if (!rowId) editor.view.focus()
  } finally {
    editor.off('transaction', map)
  }
}

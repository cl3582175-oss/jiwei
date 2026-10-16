import { useRecording } from '@/features/recording/store'
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useApp } from '@/store/app'
import { api } from './utils'
import { invalidate } from './queries'
import { toggleActiveSidebar } from '@/components/PageSidebar'
import { useAssist, getPanel } from '@/features/assist/store'
import { requestTimestamp } from '@/features/browser/courseNotes'
import { resetAttachmentDraft } from '@/features/attachments/useAttachments'

/** 新建笔记并打开（继承当前分类筛选） */
export function useCreateNote() {
  const qc = useQueryClient()
  return async (): Promise<void> => {
    const { noteFilter, openNote } = useApp.getState()
    const categoryId = noteFilter.type === 'category' ? noteFilter.id : null
    const note = await api.notes.create({ categoryId })
    qc.setQueryData(['note', note.id], note)
    invalidate(qc, 'notes', 'heatmap')
    openNote(note.id)
  }
}

export function useGlobalShortcuts(): void {
  const createNote = useCreateNote()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey) return
      const k = e.key.toLowerCase()
      const s = useApp.getState()
      if (k === 'w' && s.settingsOpen) {
        e.preventDefault()
        s.setSettingsOpen(false)
      } else if (k === 'k') {
        e.preventDefault()
        s.setPaletteOpen(!s.paletteOpen)
      } else if (k === 't' && e.shiftKey && (s.browserOpen || !!useRecording.getState().current)) {
        e.preventDefault()
        requestTimestamp()
      } else if (k === 'n' && e.shiftKey && s.browserOpen) {
        e.preventDefault()
        s.openBrowser('', { incognito: true })
      } else if (k === 't' && !e.shiftKey && s.browserOpen) {
        e.preventDefault()
        s.openBrowser('')
      } else if (k === 'n' && !e.shiftKey) {
        e.preventDefault()
        if (s.view === 'chat') {
          resetAttachmentDraft('chat')
          s.openConversation(null)
        } else void createNote()
      } else if (k === ',') {
        e.preventDefault()
        s.setSettingsOpen(true)
      } else if (k === '\\') {
        // 当前页面的列表栏（v0.7.3：各页面分别记住）
        if (toggleActiveSidebar()) e.preventDefault()
      } else if (k === '[') {
        e.preventDefault()
        s.back()
      } else if (k === ']') {
        e.preventDefault()
        s.forward()
      } else if (k === '0') {
        e.preventDefault()
        s.setView('inbox')
      } else if (k === '1') {
        e.preventDefault()
        s.setView('notes')
      } else if (k === '2') {
        e.preventDefault()
        s.setView('library')
      } else if (k === '3') {
        e.preventDefault()
        s.setView('chat')
      } else if (k === '4') {
        e.preventDefault()
        s.setView('review')
      } else if (k === '5') {
        e.preventDefault()
        s.setView('reflect')
      } else if (k === '7') {
        e.preventDefault()
        s.setView('recording')
      } else if (k === '6') {
        e.preventDefault()
        s.openGraph(null)
      } else if (k === 'l' && !(s.browserOpen && s.view === 'notes')) {
        // 内置浏览器（打开后由地址栏处理 ⌘L）
        e.preventDefault()
        s.openBrowser()
      } else if (k === 'j') {
        // 积微助手侧栏（v0.6.7 起任何页面都可以打开，带上当前页面的上下文）；在助手全屏页时无需侧栏
        e.preventDefault()
        if (s.view === 'chat') return
        const a = useAssist.getState()
        a.setPanel({ panelOpen: !getPanel().open })
      } else if (k === '9') {
        e.preventDefault()
        s.setView('today')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [createNote])
}

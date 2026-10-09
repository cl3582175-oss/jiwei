import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useApp } from '@/store/app'
import { api } from './utils'
import { invalidate } from './queries'
import { useSidebar } from '@/components/CollapsibleSidebar'
import { useAssist } from '@/features/assist/store'
import { requestTimestamp } from '@/features/browser/courseNotes'

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
  const sidebar = useSidebar()
  // 用 ref 保存最新的切换函数，避免每次设置变化都重新绑定键盘事件
  const sidebarToggle = useRef(sidebar.toggle)
  sidebarToggle.current = sidebar.toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey) return
      const k = e.key.toLowerCase()
      const s = useApp.getState()
      if (k === 'k') {
        e.preventDefault()
        s.setPaletteOpen(!s.paletteOpen)
      } else if (k === 't' && e.shiftKey && s.browserOpen) {
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
        void createNote()
      } else if (k === ',') {
        e.preventDefault()
        s.setSettingsOpen(true)
      } else if (k === '\\') {
        e.preventDefault()
        sidebarToggle.current()
      } else if (k === '[') {
        e.preventDefault()
        s.back()
      } else if (k === ']') {
        e.preventDefault()
        s.forward()
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
      } else if (k === '6') {
        e.preventDefault()
        s.openGraph(null)
      } else if (k === 'l' && !(s.browserOpen && s.view === 'notes')) {
        // 内置浏览器（打开后由地址栏处理 ⌘L）
        e.preventDefault()
        s.openBrowser()
      } else if (k === 'j') {
        // 工作区 AI 面板
        e.preventDefault()
        if (s.view !== 'notes') s.setView('notes')
        const a = useAssist.getState()
        a.setPanel({ panelOpen: !a.panelOpen || s.view !== 'notes' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [createNote])
}

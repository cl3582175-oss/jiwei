import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useApp } from '@/store/app'
import { api } from './utils'
import { invalidate } from './queries'

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
      if (k === 'k') {
        e.preventDefault()
        s.setPaletteOpen(!s.paletteOpen)
      } else if (k === 'n' && !e.shiftKey) {
        e.preventDefault()
        void createNote()
      } else if (k === ',') {
        e.preventDefault()
        s.setSettingsOpen(true)
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [createNote])
}

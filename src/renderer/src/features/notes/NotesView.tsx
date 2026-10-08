import { useApp } from '@/store/app'
import { NotesSidebar } from './NotesSidebar'
import { NoteEditor } from './NoteEditor'
import { NotesHome } from '../home/NotesHome'

export function NotesView() {
  const activeNoteId = useApp((s) => s.activeNoteId)
  return (
    <div className="flex h-full">
      <NotesSidebar />
      <div className="min-w-0 flex-1">{activeNoteId ? <NoteEditor noteId={activeNoteId} /> : <NotesHome />}</div>
    </div>
  )
}

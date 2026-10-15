import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Archive,
  Check,
  CircleAlert,
  CircleCheck,
  Folder,
  Inbox,
  PanelRightOpen,
  Pin,
  PinOff,
  Shield,
  ShieldOff,
  Trash2
} from 'lucide-react'
import type { KnowledgeStatus, NoteSummary } from '@shared/types'
import { invalidate, useCategories } from '@/lib/queries'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'
import { categoryPaths } from './CategoryTree'

// 笔记列表的操作（v0.7.6）：右键或悬停“⋯”打开；选中多篇时对全部生效。

export function useNoteActions() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: cats = [] } = useCategories('note')
  const paths = categoryPaths(cats)
  const refresh = (): void => invalidate(qc, 'notes', 'note', 'trash')
  const move = async (ids: string[], categoryId: string | null): Promise<void> => {
    await Promise.all(ids.map((id) => api.notes.update(id, { categoryId })))
    refresh()
    const name = categoryId ? (paths.get(categoryId) ?? '') : t('common.uncategorized')
    toast(ids.length > 1 ? t('notes.movedMany', { count: ids.length, name }) : t('notes.movedTo', { name }))
  }
  const remove = async (ids: string[]): Promise<boolean> => {
    const ok = await confirm({
      title: ids.length > 1 ? t('notes.deleteMany', { count: ids.length }) : t('notes.deleteTitle'),
      description: t('notes.deleteDesc'),
      confirmText: t('common.delete'),
      danger: true
    })
    if (!ok) return false
    await Promise.all(ids.map((id) => api.notes.trash(id)))
    const app = useApp.getState()
    if (app.noteId && ids.includes(app.noteId)) app.openNote(null)
    refresh()
    toast(ids.length > 1 ? t('notes.deletedMany', { count: ids.length }) : t('notes.deleted'), {
      action: {
        label: t('common.undo'),
        onClick: () => void Promise.all(ids.map((id) => api.trash.restore('note', id))).then(refresh)
      }
    })
    return true
  }
  const update = async (ids: string[], patch: { pinned?: boolean; status?: KnowledgeStatus; aiExcluded?: boolean }): Promise<void> => {
    await Promise.all(ids.map((id) => api.notes.update(id, patch)))
    refresh()
  }
  return { cats, paths, move, remove, update }
}

/** 菜单内容：notes 为要操作的笔记（单篇或已选的多篇） */
export function NoteMenuItems({ notes, onDone }: { notes: NoteSummary[]; onDone?: () => void }) {
  const { t } = useTranslation()
  const { paths, move, remove, update } = useNoteActions()
  const ids = notes.map((n) => n.id)
  const one = notes.length === 1 ? notes[0] : null
  const allPinned = notes.every((n) => n.pinned)
  const done = <T,>(p: Promise<T>): void => void p.then(() => onDone?.())
  const statusIcon: Record<KnowledgeStatus, React.ReactNode> = { active: <CircleCheck />, disputed: <CircleAlert />, outdated: <Archive /> }
  return (
    <>
      {one && (
        <MenuItem onSelect={() => useApp.getState().openNote(one.id)}>
          <PanelRightOpen />
          {t('notes.open')}
        </MenuItem>
      )}
      <MenuItem onSelect={() => done(update(ids, { pinned: !allPinned }))}>
        {allPinned ? <PinOff /> : <Pin />}
        {allPinned ? t('notes.unpin') : notes.length > 1 ? t('notes.pinMany', { count: notes.length }) : t('notes.pin')}
      </MenuItem>
      <MenuSub>
        <MenuSubTrigger>
          <Folder />
          {t('notes.moveTo')}
        </MenuSubTrigger>
        <MenuSubContent>
          <MenuItem onSelect={() => done(move(ids, null))}>
            {one && one.categoryId === null ? <Check /> : <Inbox />}
            {t('common.uncategorized')}
          </MenuItem>
          {[...paths]
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([id, path]) => (
              <MenuItem key={id} onSelect={() => done(move(ids, id))}>
                <Check className={cn(one?.categoryId !== id && 'invisible')} />
                {path}
              </MenuItem>
            ))}
        </MenuSubContent>
      </MenuSub>
      <MenuSub>
        <MenuSubTrigger>
          <CircleCheck />
          {t('notes.status.label')}
        </MenuSubTrigger>
        <MenuSubContent>
          {(['active', 'disputed', 'outdated'] as const).map((s) => (
            <MenuItem key={s} onSelect={() => done(update(ids, { status: s }))}>
              {one?.status === s ? <Check /> : statusIcon[s]}
              {t(`notes.status.${s}`)}
            </MenuItem>
          ))}
        </MenuSubContent>
      </MenuSub>
      {one && (
        <>
          <MenuItem onSelect={() => done(update(ids, { aiExcluded: !one.aiExcluded }))}>
            {one.aiExcluded ? <Shield /> : <ShieldOff />}
            {one.aiExcluded ? t('notes.aiInclude') : t('notes.aiExclude')}
          </MenuItem>
          {one.attachmentOnly && (
            <p className="max-w-64 px-2 py-1 text-xs leading-relaxed text-muted">{t('notes.notePrivacyAttachmentOnly')}</p>
          )}
        </>
      )}
      <MenuSeparator />
      <MenuItem danger onSelect={() => done(remove(ids))}>
        <Trash2 />
        {t('common.delete')}
      </MenuItem>
    </>
  )
}

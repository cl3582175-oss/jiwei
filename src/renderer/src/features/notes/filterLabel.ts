import { useTranslation } from 'react-i18next'
import { useApp } from '@/store/app'
import { useCategories, useTags } from '@/lib/queries'

/** 当前笔记筛选的名字（用于收起后的书脊）：笔记 · 考研数学 */
export function useNoteFilterLabel(): string {
  const { t } = useTranslation()
  const f = useApp((s) => s.noteFilter)
  const { data: cats = [] } = useCategories('note')
  const { data: tags = [] } = useTags()
  const name =
    f.type === 'all'
      ? t('notes.all')
      : f.type === 'pinned'
        ? t('notes.pinned')
        : f.type === 'uncategorized'
          ? t('common.uncategorized')
          : f.type === 'category'
            ? (cats.find((c) => c.id === f.id)?.name ?? '')
            : `#${tags.find((x) => x.id === f.id)?.name ?? ''}`
  return name ? `${t('notes.title')} · ${name}` : t('notes.title')
}

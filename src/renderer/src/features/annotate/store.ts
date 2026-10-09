import { useEffect } from 'react'
import { create } from 'zustand'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { toast } from 'sonner'
import type { Anchor } from '@shared/context'
import type { Annotation, AnnotationSelector } from '@shared/types'
import { api } from '@/lib/utils'
import { queryClient } from '@/lib/queryClient'
import type { Rect } from '../assist/store'

// 批注（v0.5.3）：PDF、文字资料、转写稿、笔记共用一套批注层。
// 数据在主进程 annotations 表；这里是查询、创建与弹出卡片的界面状态。

export const ANNO_COLORS = ['yellow', 'green', 'blue', 'pink'] as const
export type AnnoColor = (typeof ANNO_COLORS)[number]
export type Motivation = Annotation['motivation']

const LAST_COLOR = 'jiwei.anno.color'
export function lastColor(): AnnoColor {
  try {
    const c = localStorage.getItem(LAST_COLOR) as AnnoColor | null
    return c && (ANNO_COLORS as readonly string[]).includes(c) ? c : 'yellow'
  } catch {
    return 'yellow'
  }
}
export function rememberColor(c: AnnoColor): void {
  try {
    localStorage.setItem(LAST_COLOR, c)
  } catch {
    /* 无痕窗口等：忽略 */
  }
}

/** 某个笔记 / 资料的批注，随主进程事件刷新 */
export function useAnnotations(targetType: 'note' | 'source', targetId: string | null | undefined): Annotation[] {
  const qc = useQueryClient()
  const { data = [] } = useQuery({
    queryKey: ['annotations', targetType, targetId],
    queryFn: () => api.annotations.list(targetType, targetId!),
    enabled: !!targetId
  })
  useEffect(
    () =>
      window.jiweiEvents.on('annotations:changed', (p) => {
        if (p.targetType === targetType && p.targetId === targetId) void qc.invalidateQueries({ queryKey: ['annotations', targetType, targetId] })
      }),
    [qc, targetType, targetId]
  )
  return data
}

/** 由选区锚点生成选择器 */
export function anchorSelector(anchor: Anchor, rects?: Rect[]): AnnotationSelector {
  return {
    ...(anchor.ownerId ? { ownerId: anchor.ownerId } : {}),
    ...(anchor.quote ? { quote: anchor.quote.slice(0, 4000) } : {}),
    ...(anchor.prefix ? { prefix: anchor.prefix.slice(-200) } : {}),
    ...(anchor.suffix ? { suffix: anchor.suffix.slice(0, 200) } : {}),
    ...(anchor.start !== undefined ? { start: anchor.start } : {}),
    ...(anchor.end !== undefined ? { end: anchor.end } : {}),
    ...(anchor.page ? { page: anchor.page } : {}),
    ...(anchor.t ? { t: anchor.t } : {}),
    ...(rects?.length ? { rects: rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })) } : {})
  }
}

/** 批注 → 锚点（就这段问 AI） */
export function selectorAnchor(a: Annotation): Anchor {
  const s = a.selector
  return {
    kind: a.targetType === 'note' ? 'note-text' : 'source-text',
    parentType: a.targetType,
    parentId: a.targetId,
    ownerId: s.ownerId ?? null,
    ...(s.quote ? { quote: s.quote } : {}),
    ...(s.prefix ? { prefix: s.prefix } : {}),
    ...(s.suffix ? { suffix: s.suffix } : {}),
    ...(s.start !== undefined ? { start: s.start } : {}),
    ...(s.end !== undefined ? { end: s.end } : {}),
    ...(s.page ? { page: s.page } : {}),
    ...(s.t ? { t: s.t } : {})
  }
}

interface CardState {
  /** 打开的批注卡片：批注 ID、屏幕位置、是否直接进入编辑 */
  card: { id: string; targetType: 'note' | 'source'; targetId: string; rect: Rect; edit: boolean } | null
  open: (c: NonNullable<CardState['card']>) => void
  close: () => void
}

export const useAnnotate = create<CardState>((set) => ({
  card: null,
  open: (card) => set({ card }),
  close: () => set({ card: null })
}))

/** 新建批注；comment / question 时打开卡片写评论 */
export async function annotate(
  anchor: Anchor,
  motivation: Motivation,
  rect: Rect,
  rects?: Rect[],
  color: AnnoColor = lastColor()
): Promise<Annotation | null> {
  try {
    const a = await api.annotations.create({
      targetType: anchor.parentType,
      targetId: anchor.parentId,
      selector: anchorSelector(anchor, rects),
      motivation,
      color
    })
    queryClient.setQueryData<Annotation[]>(['annotations', a.targetType, a.targetId], (list) => [...(list ?? []), a])
    if (motivation !== 'highlighting') useAnnotate.getState().open({ id: a.id, targetType: a.targetType, targetId: a.targetId, rect, edit: true })
    window.getSelection()?.removeAllRanges()
    return a
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
    return null
  }
}

/** 删除批注（可撤销） */
export async function removeAnnotation(a: Annotation): Promise<void> {
  await api.annotations.remove(a.id)
  useAnnotate.getState().close()
  toast.success(i18n.t('annotate.removed'), {
    action: { label: i18n.t('memory.undo'), onClick: () => void api.annotations.restore(a.id) }
  })
}

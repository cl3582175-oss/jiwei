import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useHeatmap, useNotes } from './queries'
import { Logo } from '@/components/Logo'

const MILESTONES = [3, 7, 14, 30, 60, 100, 200, 365]
const KEY = 'jiwei:celebrated'

function celebrated(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function markCelebrated(id: string): void {
  try {
    const s = celebrated()
    s.add(id)
    localStorage.setItem(KEY, JSON.stringify([...s]))
  } catch {
    /* 存储不可用时只是不记忆 */
  }
}

/** 学习里程碑：第一篇笔记、连续学习 3 / 7 / 14 / 30… 天 */
export function useCelebrations(): void {
  const { t } = useTranslation()
  const { data: heat } = useHeatmap(400)
  const { data: notes } = useNotes({ limit: 2 })
  const prevNotes = useRef<number | null>(null)

  useEffect(() => {
    if (!notes) return
    if (prevNotes.current === 0 && notes.length === 1 && !celebrated().has('first-note')) {
      markCelebrated('first-note')
      toast(t('celebrate.firstNote'), { icon: <Logo size={18} /> })
    }
    prevNotes.current = notes.length
  }, [notes, t])

  useEffect(() => {
    if (!heat?.length) return
    let streak = 0
    for (let i = heat.length - 1; i >= 0; i--) {
      if (heat[i].count > 0) streak++
      else if (i === heat.length - 1) continue
      else break
    }
    const m = [...MILESTONES].reverse().find((x) => streak >= x)
    if (!m) return
    // 同一段连续学习中每个里程碑只庆祝一次
    const id = `streak-${m}-${heat[heat.length - streak]?.date ?? ''}`
    if (celebrated().has(id)) return
    markCelebrated(id)
    toast(t('celebrate.streak', { count: m }), { icon: <Logo size={18} />, duration: 5000 })
  }, [heat, t])
}

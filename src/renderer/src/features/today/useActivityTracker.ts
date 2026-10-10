import { useEffect } from 'react'
import type { ActivityKind, ActivityRef, ActivitySpan } from '@shared/activity'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'

// 学习活动记录（v0.6.7）：只统计“窗口在前台，并且最近 60 秒有键鼠操作或正在播放”的时间。
// 每 5 秒判断一次当前在做什么（读资料、听课、写笔记、和助手对话……），每分钟上报一次。
// 复习、错题练习、录音由主进程在完成时记录，这里不重复统计。

const TICK = 5000
const IDLE = 60_000
const FLUSH = 60_000

type Key = `${ActivityKind}|${ActivityRef | ''}|${string}`

/** 最近一次操作发生在资料一侧还是笔记一侧（工作区两栏并排时用来区分阅读与写作） */
function areaOf(target: EventTarget | null): 'source' | 'note' | null {
  const el = target instanceof Element ? target.closest('[data-activity-area]') : null
  const v = el?.getAttribute('data-activity-area')
  return v === 'source' || v === 'note' ? v : null
}

export function useActivityTracker(): void {
  useEffect(() => {
    let lastInput = Date.now(),
      area: 'source' | 'note' | null = null,
      browserPlaying = false,
      lastMove = 0
    const buckets = new Map<Key, number>()
    const input = (e: Event): void => {
      lastInput = Date.now()
      const a = areaOf(e.target)
      if (a) area = a
    }
    const move = (e: Event): void => {
      if (Date.now() - lastMove < 2000) return
      lastMove = Date.now()
      input(e)
    }
    const events = ['keydown', 'pointerdown', 'wheel', 'focusin'] as const
    for (const e of events) window.addEventListener(e, input, { passive: true, capture: true })
    window.addEventListener('pointermove', move, { passive: true, capture: true })
    const offPulse = window.jiweiEvents.on('activity:pulse', ({ playing }) => {
      lastInput = Date.now()
      if (playing !== null) browserPlaying = playing
    })

    const playingHere = (): boolean => [...document.querySelectorAll<HTMLMediaElement>('video, audio')].some((m) => !m.paused && !m.ended)

    const current = (): { kind: ActivityKind; refType: ActivityRef | null; refId: string | null } | null => {
      const s = useApp.getState()
      const playing = playingHere()
      if (s.view === 'notes') {
        if (s.browserOpen) return { kind: browserPlaying ? 'listen' : 'read', refType: 'web', refId: null }
        const onSource = s.sourceId && (!s.noteId || area === 'source')
        if (onSource) return { kind: playing ? 'listen' : 'read', refType: 'source', refId: s.sourceId }
        if (s.noteId) return { kind: 'write', refType: 'note', refId: s.noteId }
        return null
      }
      if (s.view === 'chat') return { kind: 'chat', refType: s.conversationId ? 'conversation' : null, refId: s.conversationId }
      if (s.view === 'feynman') return { kind: 'practice', refType: s.feynman?.conversationId ? 'conversation' : null, refId: s.feynman?.conversationId ?? null }
      if (s.view === 'reflect') return { kind: 'write', refType: null, refId: null }
      if (s.view === 'recording' && playing) return { kind: 'listen', refType: null, refId: null }
      return null
    }

    const tick = window.setInterval(() => {
      const playing = playingHere() || browserPlaying
      if (!document.hasFocus() || (Date.now() - lastInput > IDLE && !playing)) return
      const c = current()
      if (!c) return
      const key = `${c.kind}|${c.refType ?? ''}|${c.refId ?? ''}` as Key
      buckets.set(key, (buckets.get(key) ?? 0) + TICK)
    }, TICK)

    const flush = (): void => {
      if (!buckets.size) return
      const spans: ActivitySpan[] = [...buckets].map(([key, ms]) => {
        const [kind, refType, refId] = key.split('|')
        return { kind: kind as ActivityKind, refType: (refType || null) as ActivityRef | null, refId: refId || null, durationMs: Math.min(ms, 15 * 60_000) }
      })
      buckets.clear()
      void api.activity.track(spans).catch(() => undefined)
    }
    const flushTimer = window.setInterval(flush, FLUSH)
    const hidden = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('beforeunload', flush)
    return () => {
      for (const e of events) window.removeEventListener(e, input, { capture: true })
      window.removeEventListener('pointermove', move, { capture: true })
      offPulse()
      window.clearInterval(tick)
      window.clearInterval(flushTimer)
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [])
}

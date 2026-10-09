import { ipcMain, nativeImage, type IpcMainEvent } from 'electron'
import { readFile } from 'fs/promises'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  CourseAbsentSchema,
  CourseAudioStartSchema,
  CourseAudioSchema,
  CourseCaptionsSchema,
  CourseErrorSchema,
  CourseFrameSchema,
  CourseVideoSchema,
  type CourseOptionsSchema
} from '@shared/schemas'
import { mergeTranscript, type CourseCue } from '@shared/course'
import { fmtTime } from '@shared/context'
import { emit } from '../../events'
import { newId } from '../../lib/ids'
import { getDb } from '../../db'
import { sources } from '../../db/schema'
import { importBytes, assetPath } from '../assets'
import { listSegments, replaceSegments } from '../segments'
import { recognizeRegion } from '../recognize'
import { asrStatus } from '../asr'
import { enqueue, registerJobKind } from '../jobs'
import { requestIndex } from '../ai/indexer'
import { saveTab } from './pages'
import { beginAudioRecording, recordingComplete, registerCourseAudioJob, saveAudio } from './courseAudio'
import * as m from './manager'

const batches = new Map<string, { next: number; cues: CourseCue[] }>()
const lastFrame = new Map<string, number>()
const audioCaptures = new Map<string, string>()
const restoring = new Set<string>()
const snapshots = new Map<string, { tabId: string; scope: string; resolve: (image: string | null) => void; timer: NodeJS.Timeout }>()

function live(id: string, scope?: string, media?: string): ReturnType<typeof m.getTab> {
  const t = m.getTab(id)
  return t && !t.incognito && !m.isSensitive(id) && (!scope || t.scope === scope) && (!media || t.media === media) ? t : null
}

function accept<T extends { scope: string; media: string; url: string }>(
  e: IpcMainEvent,
  raw: unknown,
  schema: z.ZodType<T>,
  initial = false
): { tabId: string; data: T } | null {
  const t = m.tabOf(e.sender)
  if (!t || e.senderFrame !== e.sender.mainFrame || !live(t.id)) return null
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return null
  const data = parsed.data
  if (data.scope !== t.scope || data.url !== e.sender.getURL() || (!initial && data.media !== t.media)) return null
  return { tabId: t.id, data }
}

function error(tabId: string, message: string): void {
  const t = live(tabId)
  if (!t) return
  t.course.error = message
  m.changed()
  emit('course:event', { tabId, kind: 'error', message })
}

function restoreRecording(tabId: string): void {
  const tab = live(tabId)
  if (!tab?.video || !tab.sourceId || audioCaptures.has(tabId) || restoring.has(tabId)) return
  restoring.add(tabId)
  const { scope, media, sourceId, video } = tab
  void recordingComplete(sourceId, video.duration)
    .then((complete) => {
      const fresh = live(tabId, scope, media!)
      if (!fresh || audioCaptures.has(tabId) || fresh.sourceId !== sourceId) return
      fresh.course.recordingComplete = complete
      m.changed()
    })
    .catch(() => {})
}

export async function courseSource(tabId: string, scope?: string, media?: string): Promise<string> {
  const t = live(tabId, scope, media)
  if (!t?.video) throw new Error('Video unavailable')
  const currentScope = t.scope
  const currentMedia = t.media!
  const sourceId = t.sourceId ?? (await saveTab(tabId))
  if (!live(tabId, currentScope, currentMedia)) throw new Error('Page changed')
  const source = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
  if (!source || source.deletedAt || source.aiExcluded) throw new Error('Source unavailable or excluded from AI')
  restoreRecording(tabId)
  return sourceId
}

function localTranscription(tabId: string): void {
  const t = live(tabId)
  if (!t || t.course.mode === 'off') return
  const ready = asrStatus().state === 'ready'
  t.course.transcript = ready ? 'local' : 'needs-install'
  m.toPage(tabId, 'jw-page:record', { enabled: ready })
  m.changed()
}

export function configureCourse(tabId: string, patch: z.infer<typeof CourseOptionsSchema>): void {
  const t = live(tabId)
  if (!t?.video) throw new Error('Video unavailable')
  t.course = { ...t.course, ...patch, error: null }
  if (patch.mode) {
    t.course.transcript = patch.mode === 'off' ? 'off' : 'waiting'
    batches.delete(tabId)
    m.toPage(tabId, 'jw-page:record', { enabled: false })
  }
  m.pushConfig(tabId)
  if (patch.mode === 'local') localTranscription(tabId)
  m.changed()
}

export function snapshot(tabId: string): Promise<string | null> {
  const t = live(tabId)
  if (!t?.video) return Promise.resolve(null)
  const id = newId()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      snapshots.delete(id)
      resolve(null)
    }, 8000)
    snapshots.set(id, { tabId, scope: t.scope, resolve, timer })
    m.toPage(tabId, 'jw-page:snapshot', { requestId: id })
  })
}

function finishSnapshot(id: string, tabId: string, scope: string, image: string | null): void {
  const p = snapshots.get(id)
  if (!p || p.tabId !== tabId || p.scope !== scope) return
  clearTimeout(p.timer)
  snapshots.delete(id)
  p.resolve(image)
}

export function registerCourse(): void {
  m.onCourseReset((id) => {
    batches.delete(id)
    lastFrame.delete(id)
    audioCaptures.delete(id)
    restoring.delete(id)
    for (const [key, p] of snapshots) if (p.tabId === id) finishSnapshot(key, id, p.scope, null)
  })
  ipcMain.on('jw-page:video-absent', (e, raw: unknown) => {
    const msg = accept(e, raw, CourseAbsentSchema)
    if (msg) m.clearVideo(msg.tabId)
  })
  ipcMain.on('jw-page:video', (e, raw: unknown) => {
    const msg = accept(e, raw, CourseVideoSchema, true)
    if (!msg) return
    const { tabId, data } = msg
    const before = m.getTab(tabId)!.video
    const { currentTime, duration, paused, rate, title, ended } = data
    m.setVideo(tabId, data.media, { currentTime, duration, paused, rate, title, ended, updatedAt: Date.now() })
    restoreRecording(tabId)
    if (ended && !before?.ended) emit('course:event', { tabId, kind: 'ended' })
  })
  ipcMain.on('jw-page:captions', (e, raw: unknown) => {
    const msg = accept(e, raw, CourseCaptionsSchema)
    if (!msg || m.getTab(msg.tabId)?.course.mode !== 'auto') return
    const { tabId, data } = msg
    if (data.batch === 0) batches.set(tabId, { next: 0, cues: [] })
    const batch = batches.get(tabId)
    if (!batch || batch.next !== data.batch || batch.cues.length + data.cues.length > 100000) return
    batch.cues.push(...data.cues.filter((c) => c.end <= (m.getTab(tabId)?.video?.duration ?? 0) + 5))
    batch.next++
    if (!data.done) return
    batches.delete(tabId)
    if (!batch.cues.length) {
      localTranscription(tabId)
      return
    }
    m.toPage(tabId, 'jw-page:record', { enabled: false })
    void courseSource(tabId, data.scope, data.media)
      .then((sourceId) => {
        const t = live(tabId, data.scope, data.media)
        if (!t || t.course.mode !== 'auto') return
        replaceSegments(sourceId, mergeTranscript(listSegments(sourceId), batch.cues))
        requestIndex()
        t.course.transcript = 'captions'
        m.changed()
      })
      .catch((err: unknown) => {
        if (live(tabId, data.scope, data.media)) error(tabId, String(err))
      })
  })
  ipcMain.on('jw-page:audio-start', (e, raw: unknown) => {
    const msg = accept(e, raw, CourseAudioStartSchema)
    if (!msg) return
    const { tabId, data } = msg
    const tab = live(tabId)
    if (!tab?.video || tab.course.transcript !== 'local') return
    audioCaptures.set(tabId, data.capture)
    tab.course.recordingComplete = false
    m.changed()
    const duration = tab.video.duration
    void courseSource(tabId, data.scope, data.media)
      .then(async (sourceId) => {
        if (!live(tabId, data.scope, data.media) || audioCaptures.get(tabId) !== data.capture) return
        await beginAudioRecording(sourceId, data.capture, duration)
      })
      .catch((err: unknown) => {
        if (live(tabId, data.scope, data.media)) error(tabId, String(err))
      })
  })
  ipcMain.on('jw-page:audio', (e, raw: unknown) => {
    const msg = accept(e, raw, CourseAudioSchema)
    if (!msg) return
    const { tabId, data } = msg
    const t = live(tabId)
    if (!t?.video || t.course.transcript !== 'local' || audioCaptures.get(tabId) !== data.capture) return
    const duration = t.video.duration
    void courseSource(tabId, data.scope, data.media)
      .then(async (sourceId) => {
        if (!live(tabId, data.scope, data.media) || audioCaptures.get(tabId) !== data.capture) return
        await saveAudio(sourceId, data, duration)
      })
      .catch((err: unknown) => {
        if (live(tabId, data.scope, data.media)) error(tabId, String(err))
      })
  })
  ipcMain.on('jw-page:frame', (e, raw: unknown) => {
    const msg = accept(e, raw, CourseFrameSchema)
    if (!msg) return
    const { tabId, data } = msg
    const bytes = Buffer.from(data.jpeg)
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return
    const img = nativeImage.createFromBuffer(bytes),
      size = img.getSize()
    if (img.isEmpty() || Math.max(size.width, size.height) > 1600) return
    if (data.requestId) {
      finishSnapshot(data.requestId, tabId, data.scope, `data:image/jpeg;base64,${bytes.toString('base64')}`)
      return
    }
    if (!live(tabId)?.course.slides || Date.now() - (lastFrame.get(tabId) ?? 0) < 1500) return
    lastFrame.set(tabId, Date.now())
    void (async () => {
      const sourceId = await courseSource(tabId, data.scope, data.media)
      if (!live(tabId, data.scope, data.media)?.course.slides) return
      const asset = await importBytes('slide.jpg', 'image/jpeg', new Uint8Array(bytes))
      if (!live(tabId, data.scope, data.media)?.course.slides) return
      const current = listSegments(sourceId)
      if (
        current.some(
          (s) => s.kind === 'slide' && s.locator.image === asset.id && Math.abs(Number(String(s.locator.value).slice(2)) - data.t) < 5
        )
      )
        return
      replaceSegments(sourceId, [
        ...current,
        { kind: 'slide', locator: { type: 'FragmentSelector', value: `t=${+data.t.toFixed(3)}`, image: asset.id }, text: '' }
      ])
      enqueue('course.slide', { sourceId, assetId: asset.id, t: data.t }, { dedupeKey: `slide:${sourceId}:${asset.id}` })
      requestIndex()
      emit('course:event', { tabId, kind: 'slide' })
    })().catch((err: unknown) => {
      if (live(tabId, data.scope, data.media)) error(tabId, String(err))
    })
  })
  for (const channel of ['jw-page:audio-error', 'jw-page:frame-error'])
    ipcMain.on(channel, (e, raw: unknown) => {
      const msg = accept(e, raw, CourseErrorSchema)
      if (!msg) return
      const { tabId, data } = msg
      if (data.requestId) finishSnapshot(data.requestId, tabId, data.scope, null)
      if (data.code.startsWith('audio')) {
        const t = live(tabId)
        if (t) t.course.transcript = 'error'
      }
      error(tabId, data.code)
    })
  registerCourseAudioJob()
  registerJobKind<{ sourceId: string; assetId: string; t: number }>('course.slide', {
    title: () => 'course.jobs.slides',
    async run({ sourceId, assetId, t }, ctx) {
      const source = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
      if (!source || source.deletedAt || source.aiExcluded) return
      const bytes = await readFile(assetPath(assetId, 'jpg'))
      const text = await recognizeRegion(`data:image/jpeg;base64,${bytes.toString('base64')}`)
      if (!text || ctx.isCanceled()) return
      const fresh = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
      if (!fresh || fresh.deletedAt || fresh.aiExcluded) return
      const current = listSegments(sourceId)
      replaceSegments(
        sourceId,
        current.map((s) => (s.kind === 'slide' && s.locator.image === assetId ? { ...s, text: `［幻灯片 ${fmtTime(t)}］${text}` } : s))
      )
      requestIndex()
    }
  })
}

import { and, asc, desc, eq, isNull, lt } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { PodcastState, PodcastScript } from '@shared/discover'
import { addDays, dayStart, localDay } from '@shared/plan'
import { nextOffPeak } from '@shared/inbox'
import { getDb } from '../../db'
import { blocks, cards, feedItems, mistakes, notes, sources } from '../../db/schema'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { LOCAL_VOICES, TTS_VOICES } from '@shared/discover'
import { podcastDialogueSchema, podcastMaterial, podcastPrompt, podcastSchema, speechChunks } from '../../lib/podcast'
import { podcastDir } from '../assets'
import { tr } from '../../lib/messages'
import { getSettings } from '../settings'
import { getMeta, setMeta } from '../memory'
import { withRun } from '../agent/context'
import { isBudgetError, perRunLimit, recordUsage } from '../agent/usage'
import { synthesize, ttsChars, ttsProviders } from './tts'
import { localSpeechJob, localSpeechReady } from './localSpeech'
import { audit } from '../agent/audit'
import { requireMistakeCloud } from '../mistakesPrivacy'
import { enqueue, registerJobKind, runInWorker, runJobNow } from '../jobs'
import { allowedCandidate, allowedRelated } from './context'
import { knowledgeTarget, scoreAllowed } from './items'
import { checkDiscoveryBudget, dailyStatus, discoveryModel } from './daily'
import { discoverChanged } from './feeds'

const KEY = 'discover.podcast'
type Stored = PodcastState & { signature?: string }
function stored(now = Date.now()): Stored {
  const value = getMeta(KEY)
  if (value) {
    const row = JSON.parse(value) as Stored
    if (row.date === localDay(now)) return row
  }
  return { date: localDay(now), status: 'idle', message: null, script: null }
}
function update(patch: Partial<Stored>): void {
  setMeta(KEY, JSON.stringify({ ...stored(), ...patch }))
  discoverChanged()
}

function material(now = Date.now()) {
  const db = getDb(),
    allNotes = db.select().from(notes).all(),
    allSources = db.select().from(sources).all()
  const privateTitles = [...allNotes, ...allSources]
    .filter((r) => r.deletedAt || r.aiExcluded)
    .map((r) => r.title)
    .filter(Boolean)
  const picks = db
    .select()
    .from(feedItems)
    .where(and(isNull(feedItems.deletedAt), eq(feedItems.status, 'picked')))
    .all()
    .map((p) => {
      const refs = JSON.parse(p.related) as { type: 'note' | 'source'; id: string }[]
      let allowed =
        !!p.score &&
        scoreAllowed(JSON.parse(p.score)) &&
        allowedRelated(refs).length === refs.length &&
        !privateTitles.some((title) => `${p.title}\n${p.reason ?? ''}`.includes(title))
      try {
        allowed &&= !!knowledgeTarget(p.url) || allowedCandidate(p.url)
      } catch {
        allowed = false
      }
      return { id: p.id, title: p.title, reason: p.reason ?? '', pickedAt: p.pickedAt ?? 0, allowed }
    })
  const due = db
    .select({ card: cards })
    .from(cards)
    .innerJoin(notes, eq(notes.id, cards.noteId))
    .where(
      and(
        isNull(cards.deletedAt),
        eq(cards.suspended, false),
        isNull(notes.deletedAt),
        eq(notes.aiExcluded, false),
        eq(notes.reviewExcluded, false),
        lt(cards.due, addDays(dayStart(now), 1))
      )
    )
    .orderBy(asc(cards.due))
    .all()
    .map(({ card }) => {
      let allowed = true,
        question = ''
      if (card.mistakeId) {
        try {
          requireMistakeCloud(card.mistakeId)
          question = db.select().from(mistakes).where(eq(mistakes.id, card.mistakeId)).get()?.question ?? ''
        } catch {
          allowed = false
        }
      } else {
        question = db
          .select({ text: blocks.text })
          .from(blocks)
          .where(and(eq(blocks.noteId, card.noteId), eq(blocks.rowId, card.blockId), eq(blocks.section, 'cue'), isNull(blocks.deletedAt)))
          .orderBy(asc(blocks.position))
          .all()
          .map((b) => b.text)
          .join('\n')
      }
      return { id: card.id, due: card.due, question, allowed }
    })
  const reminders = db
    .select()
    .from(mistakes)
    .where(isNull(mistakes.deletedAt))
    .orderBy(desc(mistakes.updatedAt))
    .all()
    .map((m) => {
      let allowed = true
      try {
        requireMistakeCloud(m.id)
      } catch {
        allowed = false
      }
      return { id: m.id, question: m.question, concepts: JSON.parse(m.concepts) as string[], cause: m.cause, allowed }
    })
  const facts = podcastMaterial({ picks, cards: due, mistakes: reminders }, now)
  return {
    facts,
    signature: createHash('sha256')
      .update(JSON.stringify({ facts, language: getSettings().language }))
      .digest('hex')
  }
}

type CloudVoice = {
  kind: 'cloud'
  providerId: string
  engine: 'qwen' | 'openai'
  name: string
  voiceA: string
  voiceB: string
  style: 'solo' | 'dialogue'
}
type LocalVoice = { kind: 'local'; voiceA: string; voiceB: string; style: 'solo' | 'dialogue' }
type Voice = CloudVoice | LocalVoice

const pickPair = (ids: string[], a: string | null, b: string | null): [string, string] => {
  const voiceA = a && ids.includes(a) ? a : ids[0]
  return [voiceA, b && ids.includes(b) && b !== voiceA ? b : (ids.find((x) => x !== voiceA) ?? voiceA)]
}

/** 当前设置下用哪种 AI 语音；系统语音、服务商或本机模型不可用时返回 null（用系统语音） */
function resolveVoice(): Voice | null {
  const v = getSettings().discover.podcastVoice
  if (v?.engine === 'local') {
    if (!localSpeechReady()) return null
    const [voiceA, voiceB] = pickPair(
      LOCAL_VOICES.map((x) => x.id),
      v.voiceA,
      v.voiceB
    )
    return { kind: 'local', voiceA, voiceB, style: v.style }
  }
  if (v?.engine !== 'ai') return null
  const p = ttsProviders().find((x) => x.providerId === v.providerId) ?? ttsProviders()[0]
  if (!p) return null
  const [voiceA, voiceB] = pickPair(
    TTS_VOICES[p.engine].map((x) => x.id),
    v.voiceA,
    v.voiceB
  )
  return { kind: 'cloud', providerId: p.providerId, engine: p.engine, name: p.name, voiceA, voiceB, style: v.style }
}
function voiceLabel(voice: Voice, dialogue: boolean): string {
  const zh = getSettings().language.startsWith('zh')
  const list = voice.kind === 'local' ? LOCAL_VOICES : TTS_VOICES[voice.engine]
  const name = (id: string): string => {
    const v = list.find((x) => x.id === id)
    return v ? (zh ? v.zh : v.en).replace(/[（(].*$/, '') : id
  }
  const who = `${name(voice.voiceA)}${dialogue ? ` / ${name(voice.voiceB)}` : ''}`
  return voice.kind === 'local' ? `${tr('本机', 'On-device')} · ${who}` : `${voice.name} · ${who}`
}

/** 逐句合成并写入当天目录；云端每句之前检查预算与取消，本机按段交给后台工作进程 */
async function synthesizeScript(
  script: PodcastScript,
  voice: Voice,
  guard: () => void,
  worker: <T>(task: string, payload: unknown) => Promise<T>,
  signal?: AbortSignal
): Promise<{ p: number; url: string }[]> {
  const language = getSettings().language,
    dir = podcastDir(script.date)
  await rm(podcastDir(), { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const out: { p: number; url: string }[] = []
  let n = 0
  const nextFile = (ext: string): string => `${String(n++).padStart(3, '0')}.${ext}`
  for (const [p, text] of script.paragraphs.entries()) {
    const id = script.speakers?.[p] === 'B' ? voice.voiceB : voice.voiceA
    if (voice.kind === 'local') {
      guard()
      const items = speechChunks(text, 200).map((chunk) => ({ text: chunk, out: join(dir, nextFile('wav')) }))
      await worker('speech', localSpeechJob(id, items))
      for (const item of items) out.push({ p, url: `jiwei://podcast/${script.date}/${basename(item.out)}` })
      continue
    }
    for (const chunk of speechChunks(text, voice.engine === 'qwen' ? 280 : 1500)) {
      guard()
      const started = Date.now()
      const audio = await synthesize(voice.providerId, id, chunk, language, signal)
      recordUsage(
        voice.providerId,
        audio.model,
        { inputTokens: ttsChars(chunk), outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
        undefined,
        Date.now() - started
      )
      const file = nextFile(audio.ext)
      await writeFile(join(dir, file), audio.data)
      out.push({ p, url: `jiwei://podcast/${script.date}/${file}` })
    }
  }
  return out
}

/** 删除过期日期的音频（启动时调用） */
async function pruneAudio(): Promise<void> {
  const today = localDay(Date.now())
  try {
    for (const d of await readdir(podcastDir())) if (d !== today) await rm(podcastDir(d), { recursive: true, force: true })
  } catch {
    /* 目录不存在 */
  }
}

export function podcast(): PodcastState {
  const row = stored()
  if (!getSettings().discover.podcast) return { date: row.date, status: 'idle', message: null, script: null }
  if (row.script && row.signature !== material().signature)
    return {
      date: row.date,
      status: row.status === 'ok' ? 'stale' : row.status,
      script: null,
      message:
        row.status === 'ok'
          ? tr('素材或隐私设置已变化，请重新生成讲稿', 'Materials or privacy settings changed; regenerate the script')
          : row.message
    }
  return { date: row.date, status: row.status, message: row.message, script: row.script }
}
export function generatePodcast(immediate = true): string {
  const s = getSettings()
  if (!s.discover.podcast) throw new Error(tr('请先开启每日学习播客', 'Enable the daily learning podcast first'))
  if (stored().status === 'running') throw new Error(tr('讲稿正在生成', 'Script generation is already running'))
  if (!s.ai.chat.model) throw new Error(tr('请先配置 AI 模型', 'Configure an AI model first'))
  const id = enqueue('discover.podcast', {}, { dedupeKey: 'discover.podcast', ...(immediate ? {} : { runAfter: nextOffPeak(Date.now()) }) })
  update({ status: 'queued', message: null })
  if (immediate) runJobNow(id)
  return id
}
export function checkPodcast(now = Date.now()): void {
  const s = getSettings()
  if (!s.discover.podcast || !s.ai.chat.model || stored(now).status !== 'idle' || ['queued', 'running'].includes(dailyStatus().status))
    return
  const f = material(now).facts
  if (!f.picks.length && !f.questions.length && !f.reminder) return
  generatePodcast(false)
}
export function registerPodcastJob(): void {
  if (stored().status === 'running')
    update({
      status: 'error',
      message: tr('上次讲稿生成被中断，可重新生成', 'The previous script generation was interrupted; regenerate it')
    })
  void pruneAudio()
  registerJobKind('discover.podcast', {
    title: () => tr('每日学习播客', 'Daily learning podcast'),
    offPeak: true,
    maxAttempts: 1,
    retryOnRestart: false,
    run: async (_payload, ctx) => {
      const input = material(),
        date = localDay(Date.now()),
        language = getSettings().language
      const guard = (): void => {
        ctx.signal?.throwIfAborted()
        if (ctx.isCanceled() || !getSettings().discover.podcast || localDay(Date.now()) !== date) throw new Error('Canceled')
        checkDiscoveryBudget()
        if (material().signature !== input.signature) throw new Error('Podcast materials changed')
      }
      update({ status: 'running', message: null })
      const voice = resolveVoice(),
        dialogue = voice?.style === 'dialogue'
      try {
        const script: PodcastScript = await withRun({ purpose: 'discover.podcast', caller: 'job', perRun: perRunLimit() }, async () => {
          guard()
          if (!input.facts.picks.length && !input.facts.questions.length && !input.facts.reminder) throw new Error('No podcast materials')
          if (dialogue) {
            const draft = await discoveryModel(
              'discover.podcast',
              podcastDialogueSchema(language),
              podcastPrompt(language, 'dialogue'),
              input.facts,
              guard,
              ctx.signal
            )
            guard()
            return {
              date,
              paragraphs: draft.turns.map((x) => x.text),
              speakers: draft.turns.map((x) => x.speaker),
              createdAt: Date.now()
            } satisfies PodcastScript
          }
          const draft = await discoveryModel(
            'discover.podcast',
            podcastSchema(language),
            podcastPrompt(language),
            input.facts,
            guard,
            ctx.signal
          )
          guard()
          return { date, paragraphs: draft.paragraphs, createdAt: Date.now() } satisfies PodcastScript
        })
        let message: string | null =
          !voice && getSettings().discover.podcastVoice?.engine === 'local'
            ? tr('本机语音模型还没有下载，这期先用系统语音', 'The local voice model is not downloaded; using the system voice for now')
            : null
        if (voice) {
          // 讲稿先落盘，合成期间也能用系统语音听
          update({
            status: 'running',
            script,
            signature: input.signature,
            message: tr('讲稿已写好，正在合成语音…', 'Script ready; synthesizing speech…')
          })
          try {
            script.audio = await withRun({ purpose: 'discover.podcast', caller: 'job', perRun: perRunLimit() }, () =>
              synthesizeScript(script, voice, guard, (task, payload) => ctx.worker(task, payload, ctx.signal), ctx.signal)
            )
            script.voiceLabel = voiceLabel(voice, dialogue)
          } catch (e) {
            if (ctx.signal?.aborted || ctx.isCanceled()) throw e
            script.audio = null
            message = isBudgetError(e)
              ? tr(
                  '今日发现费用已达上限，语音未合成，可用系统语音收听',
                  'Discovery budget reached; speech not synthesized, system voice is available'
                )
              : tr(
                  `AI 语音合成失败，已改用系统语音：${e instanceof Error ? e.message.slice(0, 120) : ''}`,
                  `AI speech failed; using the system voice: ${e instanceof Error ? e.message.slice(0, 120) : ''}`
                )
          }
        }
        update({ status: 'ok', script, signature: input.signature, message })
        audit({ caller: 'job', tool: 'discover.podcast', level: 'write', status: 'ok', summary: 'Daily learning script saved' })
      } catch (e) {
        const status = isBudgetError(e)
          ? 'budget'
          : ctx.signal?.aborted || ctx.isCanceled() || !getSettings().discover.podcast
            ? 'canceled'
            : 'error'
        const message =
          status === 'budget'
            ? tr('今日发现费用已达上限，讲稿生成已停止', 'Discovery budget reached; script generation stopped')
            : status === 'canceled'
              ? tr('讲稿生成已取消', 'Script generation canceled')
              : tr('讲稿未生成，请检查模型、素材或重新生成', 'Script not generated; check model and materials or try again')
        update({ status, message })
        audit({ caller: 'job', tool: 'discover.podcast', level: 'write', status: 'error', summary: message })
        // 队列会保存异常，说明书§0.2禁止把原模型响应或可能的凭证复制进日志。
        // eslint-disable-next-line preserve-caught-error -- 此处是错误脱敏边界，分类已写入领域状态和审计。
        throw new Error(message)
      }
    },
    onCancel: () => update({ status: 'canceled', message: tr('讲稿生成已取消', 'Script generation canceled') })
  })
}

/** 试听一个声音：合成一句示例，返回 jiwei://podcast/preview/… 地址。本机免费；云端按字数计费（约 ¥0.005） */
export async function previewVoice(engine: 'local' | 'ai', voice: string, providerId: string | null): Promise<string> {
  const zh = getSettings().language.startsWith('zh')
  const text = zh
    ? '早上好，欢迎收听今天的学习播客。先别急着翻答案，想一想：这个问题你还记得吗？'
    : "Good morning, and welcome to today's learning podcast. Before checking the answer, take a moment: do you still remember this one?"
  const dir = podcastDir('preview')
  await mkdir(dir, { recursive: true })
  const stamp = Date.now().toString(36)
  if (engine === 'local') {
    const out = join(dir, `${stamp}.wav`)
    await runInWorker('speech', localSpeechJob(voice, [{ text, out }]))
    return `jiwei://podcast/preview/${stamp}.wav`
  }
  const provider = ttsProviders().find((p) => p.providerId === providerId) ?? ttsProviders()[0]
  if (!provider) throw new Error(tr('还没有可用的语音服务商', 'No speech provider is available'))
  checkDiscoveryBudget()
  const audio = await withRun({ purpose: 'discover.podcast', caller: 'app', perRun: perRunLimit() }, async () => {
    const started = Date.now()
    const a = await synthesize(provider.providerId, voice, text, getSettings().language)
    recordUsage(
      provider.providerId,
      a.model,
      { inputTokens: ttsChars(text), outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
      undefined,
      Date.now() - started
    )
    return a
  })
  await writeFile(join(dir, `${stamp}.${audio.ext}`), audio.data)
  return `jiwei://podcast/preview/${stamp}.${audio.ext}`
}

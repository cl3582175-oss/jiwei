import { app, dialog, shell, type BrowserWindow } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, lstatSync, writeFileSync, rmSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { z } from 'zod'
import { LensSave, type LensInfo } from '@shared/lens'
import { createLensSkill, validateLensMetadata } from '../../lib/lensSkill'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import log from 'electron-log/main'
import type { SkillInfo } from '@shared/types'
import { parseSkill, type ParsedSkill as Parsed } from '../../lib/skillFormat'
import type { ModelTier } from '@shared/ai'
import { getSettings, setSettings } from '../settings'
import { skillPreferences } from '../memory'

// 技能：采用 Agent Skills 开放标准（https://agentskills.io）——每个技能一个文件夹，核心是 SKILL.md
// （YAML 头 name / description + Markdown 正文），可附带 references 等文件。
// 渐进加载：平时只把名称与简介放进提示词；需要时再加载正文（省 token，也让弱模型按流程做事）。
// 内置技能在 resources/skills；用户技能在 <用户目录>/skills，同名时用户版本优先（可自定义内置技能）。
// 积微扩展字段放在标准的 metadata 中：title（显示名）、min-model（basic / strong）、surfaces（适用位置）。

export const builtinSkillsDir = (): string => join(app.getAppPath(), 'resources', 'skills').replace('app.asar', 'app.asar.unpacked')
export const userSkillsDir = (): string => join(app.getPath('userData'), 'skills')

interface Loaded extends Parsed {
  dir: string
  source: SkillInfo['source']
}

let cache: Map<string, Loaded> | null = null
const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}

function scan(root: string, source: SkillInfo['source'], into: Map<string, Loaded>): void {
  if (!existsSync(root)) return
  for (const d of readdirSync(root)) {
    const dir = join(root, d)
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) continue
    try {
      const parsed = parseSkill(readFileSync(file, 'utf8'), d)
      const isLens = parsed.metadata.kind === 'lens' || d.startsWith('lens-')
      if (isLens && (isSymlink(root) || isSymlink(dir) || isSymlink(file))) continue
      if (isLens) validateLensMetadata(parsed.metadata)
      into.set(d, { ...parsed, dir, source })
    } catch (e) {
      log.warn('[skills] skip', file, e instanceof Error ? e.message : e)
    }
  }
}

function all(): Map<string, Loaded> {
  if (cache) return cache
  const m = new Map<string, Loaded>()
  scan(builtinSkillsDir(), 'builtin', m)
  scan(userSkillsDir(), 'user', m)
  cache = m
  return m
}

export function reloadSkills(): void {
  cache = null
}

const disabled = (): Set<string> => new Set(getSettings().ai.disabledSkills ?? [])

const toInfo = (s: Loaded, off: Set<string>): SkillInfo => ({
  name: s.name,
  description: s.description,
  title: s.metadata.title || s.name,
  source: s.source,
  enabled: !off.has(s.name),
  minModel: s.metadata['min-model'] === 'strong' ? 'strong' : 'basic',
  surfaces: (s.metadata.surfaces ?? 'chat,workspace')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  path: s.dir,
  license: s.license
})

export function listSkills(): SkillInfo[] {
  const off = disabled()
  return [...all().values()]
    .filter((s) => s.metadata.kind !== 'lens')
    .map((s) => toInfo(s, off))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 当前模型可用的技能（tier 由模型能力决定，见 resolveCaps） */
export function availableSkills(tier: ModelTier): SkillInfo[] {
  return listSkills().filter((s) => s.enabled && (s.minModel === 'basic' || tier === 'strong'))
}

/** 提示词中的技能目录（只有名称与简介） */
export function skillCatalog(tier: ModelTier, zh: boolean): string | null {
  const list = availableSkills(tier)
  if (!list.length) return null
  return [
    zh
      ? '可用技能（任务与某个技能相符时，先调用 skills_load 读取它的完整流程，再严格照做）：'
      : 'Available skills (when a task matches one, call skills_load first and follow it exactly):',
    ...list.map((s) => `- ${s.name}：${s.description}`)
  ].join('\n')
}

/** 加载技能正文 + 附带文件清单 + 用户对该技能的偏好（记忆） */
export function loadSkill(name: string, zh: boolean): string {
  const s = all().get(name)
  if (!s || s.metadata.kind === 'lens' || disabled().has(name)) throw new Error(`没有名为 ${name} 的可用技能`)
  const files = readdirSync(s.dir, { recursive: true })
    .map(String)
    .filter((f) => f !== 'SKILL.md' && statSync(join(s.dir, f)).isFile())
  const prefs = skillPreferences(name)
  return [
    `# ${zh ? '技能' : 'Skill'}：${s.metadata.title || s.name}`,
    s.body,
    files.length
      ? `${zh ? '附带文件（需要时用 skills_read_file 读取）' : 'Bundled files (read with skills_read_file)'}：\n${files.map((f) => `- ${f}`).join('\n')}`
      : '',
    prefs.length
      ? `${zh ? '用户对这个技能的偏好（优先遵守）' : "User's preferences for this skill (take precedence)"}：\n${prefs.map((p) => `- ${p}`).join('\n')}`
      : ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 读取技能附带的文件（限制在技能目录内） */
export function readSkillFile(name: string, path: string): string {
  const s = all().get(name)
  if (!s) throw new Error(`没有名为 ${name} 的技能`)
  const full = resolve(s.dir, path)
  if (relative(s.dir, full).startsWith('..') || !full.startsWith(s.dir + sep)) throw new Error('路径必须在技能目录内')
  return readFileSync(full, 'utf8').slice(0, 40_000)
}

export function setSkillEnabled(name: string, enabled: boolean): SkillInfo[] {
  const ai = getSettings().ai
  const off = new Set(ai.disabledSkills ?? [])
  if (enabled) off.delete(name)
  else off.add(name)
  setSettings({ ai: { ...ai, disabledSkills: [...off] } })
  return listSkills()
}

/** 导入技能：选择包含 SKILL.md 的文件夹（或 SKILL.md 文件本身），复制到用户技能目录 */
export async function importSkill(win: BrowserWindow | null): Promise<SkillInfo | null> {
  const opts = {
    title: '导入技能',
    properties: ['openDirectory', 'openFile'] as ('openDirectory' | 'openFile')[],
    filters: [{ name: 'SKILL.md', extensions: ['md'] }]
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (r.canceled || !r.filePaths[0]) return null
  return importSkillFrom(r.filePaths[0])
}

export function importSkillFrom(path: string): SkillInfo {
  const dir = basename(path).toLowerCase() === 'skill.md' ? dirname(path) : path
  const parsed = parseSkill(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
  const target = join(userSkillsDir(), parsed.name)
  mkdirSync(userSkillsDir(), { recursive: true })
  cpSync(dir, target, { recursive: true, force: true })
  reloadSkills()
  return toInfo(all().get(parsed.name)!, disabled())
}

export function listLenses(): LensInfo[] {
  return [...all().values()]
    .filter((s) => s.metadata.kind === 'lens')
    .map((s) => ({
      id: s.name,
      title: s.metadata.title || s.description,
      instruction: s.body,
      ...validateLensMetadata(s.metadata),
      source: s.source,
      hash: createHash('sha256')
        .update(readFileSync(join(s.dir, 'SKILL.md')))
        .digest('hex')
    }))
}
export function saveLens(input: z.infer<typeof LensSave>, id?: string): LensInfo {
  input = LensSave.parse(input)
  const original = id || input.copyFrom ? listLenses().find((s) => s.id === (id ?? input.copyFrom)) : undefined
  if ((id || input.copyFrom) && (!original || (id && original.source !== 'user'))) throw new Error('Invalid lens identity')
  const name = original?.id ?? `lens-${randomBytes(4).toString('hex')}`
  const contents = createLensSkill(name, input.title, input.instruction, original)
  if (isSymlink(userSkillsDir())) throw new Error('Invalid lens root')
  const folder = join(userSkillsDir(), name)
  if (isSymlink(folder)) throw new Error('Invalid lens directory')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, 'SKILL.md')
  if (isSymlink(file)) throw new Error('Invalid lens file')
  writeFileSync(file, contents, 'utf8')
  reloadSkills()
  return listLenses().find((l) => l.id === name)!
}
export function removeLens(id: string): void {
  const lens = listLenses().find((l) => l.id === id && l.source === 'user')
  if (!lens || !/^lens-[a-z0-9-]{1,48}$/.test(lens.id)) throw new Error('Invalid lens identity')
  rmSync(join(userSkillsDir(), lens.id), { recursive: true, force: true })
  reloadSkills()
}

export function openUserSkillsDir(): void {
  mkdirSync(userSkillsDir(), { recursive: true })
  void shell.openPath(userSkillsDir())
}

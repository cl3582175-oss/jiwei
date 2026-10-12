import { dialog, shell, type BrowserWindow } from 'electron'
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, relative } from 'path'
import { randomBytes } from 'crypto'
import JSZip from 'jszip'
import { z } from 'zod'
import { PLUGIN_RECIPE_TOOLS, PluginRecipeSchema } from '@shared/plugins'
import { tr } from '../../lib/messages'
import { skillSource } from '../ai/skills'
import { listTasks } from '../tasks/service'
import { listFeeds } from '../discover/feeds'
import { registeredPlugin } from './registry'
import { authoringRoot } from './state'

// 自己做角色包（v0.10）：自定义一个已装的包，或从自己的技能、视角、任务、订阅源组装一个新包。
// 作品放在 <userData>/plugins/authoring/<名字>/，是标准的 Claude Code 插件文件夹，可以直接编辑；
// 安装和更新都走普通的本地文件夹安装（预览 → 确认），改完点“更新”重新读取。

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const RolePackInput = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).default(''),
  skills: z.array(z.string().min(1).max(257)).max(30).default([]),
  tasks: z.array(z.string().min(1).max(64)).max(10).default([]),
  feeds: z.array(z.string().min(1).max(64)).max(30).default([])
})

/** 自制包的目录：名字由积微生成并校验，渲染进程只能给名字，不能给路径 */
export function authoredPath(name: string): string {
  if (!NAME.test(name) || name.length > 64) throw new Error('Invalid plugin name')
  return join(authoringRoot(), name)
}
function freeName(base: string): string {
  let name = base,
    n = 2
  while (existsSync(join(authoringRoot(), name))) name = `${base}-${n++}`
  return name
}
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'
/** 复制时跳过符号链接，只复制普通文件和目录 */
async function copyTree(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    filter: async (src) => !(await lstat(src)).isSymbolicLink()
  })
}

/** 自定义：把一个已装的插件复制成可编辑的本地副本，名字加 -custom，起步卡里的引用跟着改名 */
export async function customizePlugin(id: string): Promise<string> {
  const parsed = registeredPlugin(id)
  if (!parsed) throw new Error('Plugin unavailable')
  const old = parsed.manifest.name
  const name = freeName(`${old}-custom`)
  const dir = authoredPath(name)
  await mkdir(authoringRoot(), { recursive: true })
  await copyTree(parsed.root, dir)
  const manifestFile = join(dir, '.claude-plugin', 'plugin.json')
  const manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, 'utf8')) : {}
  const display = parsed.extension?.name ? tr(parsed.extension.name.zh, parsed.extension.name.en) : (parsed.manifest.displayName ?? old)
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await writeFile(
    manifestFile,
    json({
      ...manifest,
      name,
      displayName: tr(`${display}（自定义）`, `${display} (custom)`),
      version: '1.0.0',
      metadata: { ...manifest.metadata, 'jiwei.customizedFrom': id }
    })
  )
  const ext = join(dir, 'jiwei', 'manifest.json')
  if (existsSync(ext)) {
    const m = JSON.parse(await readFile(ext, 'utf8'))
    if (m.name) m.name = { zh: `${m.name.zh}（自定义）`, en: `${m.name.en} (custom)` }
    await writeFile(ext, json(m))
  }
  const starters = join(dir, 'jiwei', 'starters.json')
  if (existsSync(starters)) await writeFile(starters, (await readFile(starters, 'utf8')).split(`"${old}:`).join(`"${name}:`))
  return name
}

/** 新建角色包：从现有技能 / 视角、AI 任务（转成默认关闭的配方）、订阅源组装 */
export async function createRolePack(input: z.input<typeof RolePackInput>): Promise<{ name: string; skipped: string[] }> {
  const v = RolePackInput.parse(input)
  const name = freeName(`my-role-${randomBytes(3).toString('hex')}`)
  const dir = authoredPath(name)
  const skipped: string[] = []
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await mkdir(join(dir, 'jiwei'), { recursive: true })
  try {
    await writeFile(
      join(dir, '.claude-plugin', 'plugin.json'),
      json({ name, displayName: v.name, version: '1.0.0', description: v.description || v.name, author: { name: tr('我', 'Me') } })
    )
    await writeFile(
      join(dir, 'jiwei', 'manifest.json'),
      json({
        schema: 1,
        category: 'role',
        name: { zh: v.name, en: v.name },
        description: { zh: v.description || v.name, en: v.description || v.name },
        engines: { jiwei: '>=0.10.0' }
      })
    )
    const used = new Set<string>()
    for (const skill of v.skills) {
      const src = skillSource(skill)
      // 同名文件夹只放一个（不同插件可能有同名技能）
      if (!src || used.has(src.folder)) {
        skipped.push(skill)
        continue
      }
      used.add(src.folder)
      await copyTree(src.dir, join(dir, src.kind === 'lens' ? join('jiwei', 'lenses') : 'skills', src.folder))
    }
    const tasks = listTasks().filter((t) => v.tasks.includes(t.id))
    if (tasks.length) {
      await mkdir(join(dir, 'jiwei', 'recipes'), { recursive: true })
      for (const [i, t] of tasks.entries()) {
        const tools = t.tools.filter((x) => PLUGIN_RECIPE_TOOLS.includes(x))
        const recipe = PluginRecipeSchema.safeParse({
          id: `task-${i + 1}`,
          name: { zh: t.name, en: t.name },
          instructionEn: t.instruction,
          task: {
            name: t.name,
            instruction: t.instruction,
            trigger: t.trigger,
            tools,
            outputs: t.outputs,
            budgetPerRun: t.budgetPerRun,
            enabled: false,
            recipe: null
          }
        })
        if (!tools.length || !recipe.success) {
          skipped.push(t.name)
          continue
        }
        await writeFile(join(dir, 'jiwei', 'recipes', `task-${i + 1}.json`), json(recipe.data))
      }
    }
    const feeds = listFeeds().filter((f) => v.feeds.includes(f.id))
    if (feeds.length)
      await writeFile(join(dir, 'jiwei', 'sources.json'), json({ feeds: feeds.map((f) => ({ url: f.url, title: f.title, kind: f.kind })) }))
    await writeFile(
      join(dir, 'README.md'),
      `# ${v.name}\n\n${v.description}\n\n${tr('由积微生成的角色包。可以直接编辑这个文件夹，然后在积微里点“更新”重新载入。', 'A role pack made in Jiwei. Edit this folder, then choose Update in Jiwei to reload it.')}\n`
    )
  } catch (e) {
    await rm(dir, { recursive: true, force: true })
    throw e
  }
  return { name, skipped }
}

async function zipFolder(dir: string, file: string, prefix: string): Promise<void> {
  const zip = new JSZip()
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(full)
      else zip.file(`${prefix}/${relative(dir, full)}`, await readFile(full))
    }
  }
  await walk(dir)
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

/**
 * 导出为插件：标准 Claude Code 插件文件夹 + zip。withMarketplace 时再包一层市场（.claude-plugin/marketplace.json），
 * 推到自己的 GitHub 仓库后，别人在积微或 Claude Code 里添加这个仓库就能安装。积微不代用户建仓库或提交。
 */
export async function exportPlugin(
  id: string,
  win: BrowserWindow | null,
  withMarketplace: boolean,
  target?: string
): Promise<string | null> {
  const parsed = registeredPlugin(id)
  if (!parsed) throw new Error('Plugin unavailable')
  let parent = target
  if (!parent) {
    const opts = {
      title: tr('导出到', 'Export to'),
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    parent = r.filePaths[0]
  }
  const name = parsed.manifest.name
  const root = join(parent, withMarketplace ? `${name}-marketplace` : name)
  if (existsSync(root)) throw new Error(tr(`目标位置已有同名文件夹：${root}`, `A folder with this name already exists: ${root}`))
  const pluginDir = withMarketplace ? join(root, 'plugins', name) : root
  await copyTree(parsed.root, pluginDir)
  if (withMarketplace) {
    await mkdir(join(root, '.claude-plugin'), { recursive: true })
    await writeFile(
      join(root, '.claude-plugin', 'marketplace.json'),
      json({
        name: `${name}-marketplace`,
        owner: { name: typeof parsed.manifest.author === 'object' ? (parsed.manifest.author?.name ?? 'me') : 'me' },
        plugins: [{ name, source: `./plugins/${name}`, description: parsed.manifest.description ?? name }]
      })
    )
  }
  await zipFolder(root, `${root}.zip`, withMarketplace ? `${name}-marketplace` : name)
  shell.showItemInFolder(root)
  return root
}

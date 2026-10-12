import { readFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { parseMarketplace, type PluginTemplate, type PluginFramework, type PluginRecipe } from '@shared/plugins'
import { TaskSave, TASK_READ_TOOLS } from '@shared/tasks'
import { validateLensMetadata } from '../../../lib/lensSkill'
import { parsePlugin } from '../components'
import specification from './roles-spec.expected.json'

const root = join(process.cwd(), 'resources/marketplace')
// 独立从绑定规格抄录的期望；资源生成或内容缺失不能改变这些期望。
const expected = specification as Record<
  string,
  {
    skills: string[]
    lenses: string[]
    starters: string[]
    lensSettings: { id: string; scenes: string; output: string; landing: string }[]
    starterActions: { id: string; title: string; kind: string; ref: string }[]
    templates: { id: string; title: string; type: PluginTemplate['type']; mode: string; outline: string[] }[]
    frameworks: {
      id: string
      title: string
      criteria: Pick<PluginFramework['criteria'][number], 'name' | 'weight'>[]
      questions: string[]
    }[]
    recipes: {
      id: string
      name: string
      trigger: PluginRecipe['task']['trigger']
      tools: string[]
      outputs: PluginRecipe['task']['outputs']
    }[]
  }
>

describe('authored official roles through the production parser', () => {
  it('makes all eight optional roles discoverable through standard relative marketplace entries', async () => {
    const market = parseMarketplace(JSON.parse(await readFile(join(root, '.claude-plugin/marketplace.json'), 'utf8')), true)
    expect(
      market.plugins
        .filter((p) => p.name.startsWith('role-'))
        .map((p) => p.name)
        .sort()
    ).toEqual(
      Object.keys(expected)
        .map((id) => `role-${id}`)
        .sort()
    )
    for (const id of Object.keys(expected)) {
      const entry = market.plugins.find((p) => p.name === `role-${id}`)!
      expect(entry.source).toBe(`./plugins/role-${id}`)
      const parsed = await parsePlugin(join(root, entry.source as string), { entry, trustedBuiltin: true })
      expect(parsed.manifest.name).toBe(entry.name)
      expect(parsed.extension?.category).toBe('role')
      expect(parsed.extension?.roles).toEqual([id])
    }
  })
  it.each(Object.keys(expected))('%s delivers the exact specified contributions and navigable starter references', async (role) => {
    const p = await parsePlugin(join(root, 'plugins', `role-${role}`)),
      want = expected[role]
    expect(p.issues).toEqual([])
    expect(p.unsupported).toEqual([])
    expect(p.scripts).toEqual([])
    expect(p.mcpServers).toEqual({})
    const lenses = p.skills.filter((s) => s.metadata.kind === 'lens'),
      skills = p.skills.filter((s) => s.metadata.kind !== 'lens')
    expect(skills.map((s) => s.localName).sort()).toEqual([...want.skills].sort())
    expect(lenses.map((s) => s.localName).sort()).toEqual([...want.lenses].sort())
    expect(
      lenses
        .map((s) => ({ id: s.localName, scenes: s.metadata.scenes, output: s.metadata.output, landing: s.metadata.landing }))
        .sort((a, b) => a.id.localeCompare(b.id))
    ).toEqual([...want.lensSettings].sort((a, b) => a.id.localeCompare(b.id)))
    for (const lens of lenses) {
      expect(() => validateLensMetadata(lens.metadata)).not.toThrow()
      expect(lens.metadata.output).toBe('items')
      expect(lens.metadata.scenes.split(',').every((s) => ['meeting', 'lecture', 'thought'].includes(s.trim()))).toBe(true)
    }
    for (const skill of skills) {
      const lines = skill.body.trim().split('\n')
      expect(lines.length).toBeGreaterThanOrEqual(60)
      expect(lines.length).toBeLessThanOrEqual(120)
      expect(skill.description.length).toBeLessThanOrEqual(120)
      expect(skill.metadata.surfaces).toBe('chat,workspace')
      expect(lines.at(-1)).toBe('用用户使用的语言回答。')
      expect(skill.body.match(/^## .+$/gm)).toEqual(['## 步骤', '## 产出', '## 不要做', '## 示例'])
      expect(skill.body.split('## 示例')[1].trim().split('\n').length).toBeLessThanOrEqual(15)
    }
    expect(
      p.templates
        .map((t) => ({ id: t.id, type: t.type, mode: t.mode, title: t.title.zh, outline: t.outline }))
        .sort((a, b) => a.id.localeCompare(b.id))
    ).toEqual([...want.templates].sort((a, b) => a.id.localeCompare(b.id)))
    expect(
      p.frameworks
        .map((f) => ({
          id: f.id,
          title: f.title.zh,
          criteria: f.criteria.map(({ name, weight }) => ({ name, weight })),
          questions: f.questions
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    ).toEqual([...want.frameworks].sort((a, b) => a.id.localeCompare(b.id)))
    expect(
      p.recipes
        .map((r) => ({ id: r.id, name: r.name.zh, trigger: r.task.trigger, tools: r.task.tools, outputs: r.task.outputs }))
        .sort((a, b) => a.id.localeCompare(b.id))
    ).toEqual([...want.recipes].sort((a, b) => a.id.localeCompare(b.id)))
    for (const r of p.recipes) {
      expect(TaskSave.safeParse(r.task).success).toBe(true)
      expect(r.task.tools.every((t) => (TASK_READ_TOOLS as readonly string[]).includes(t))).toBe(true)
      expect(r.task.budgetPerRun).toBeNull()
      expect(r.task.enabled).toBe(false)
      expect(r.requires).toBeUndefined()
    }
    expect(p.starters.map((s) => s.id).sort()).toEqual([...want.starters].sort())
    expect(
      p.starters.map((s) => ({
        id: s.id,
        title: s.title.zh,
        kind: s.action.kind,
        ref:
          s.action.kind === 'chat'
            ? s.action.skill
            : s.action.kind === 'advisor'
              ? s.action.framework
              : s.action.kind === 'work'
                ? s.action.template
                : (s.action.recipe ?? s.action.recipeRef)
      }))
    ).toEqual(want.starterActions)
    for (const s of p.starters) {
      const a = s.action,
        namespace = (id: string) => `role-${role}:${id}`
      if (a.kind === 'chat') expect(skills.map((s) => s.name)).toContain(a.skill)
      if (a.kind === 'advisor') expect(p.frameworks.map((f) => namespace(f.id))).toContain(a.framework)
      if (a.kind === 'work') expect(p.templates.map((t) => namespace(t.id))).toContain(a.template)
      if (a.kind === 'recipe' && a.recipe) expect(p.recipes.map((r) => namespace(r.id))).toContain(a.recipe)
    }
    expect(p.feeds.length).toBeGreaterThanOrEqual(1)
    expect(p.feeds.length).toBeLessThanOrEqual(10)
    expect(new Set(p.feeds.map((f) => f.url)).size).toBe(p.feeds.length)
    expect(p.capabilities.commands).toEqual([])
    expect(p.capabilities.sensitive).toEqual([])
  })
})

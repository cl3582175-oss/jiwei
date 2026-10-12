import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { PluginStartersSchema } from '@shared/plugins'
import { parsePlugin } from '../components'
const roots: string[] = []
async function file(root: string, path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value))
}
const text = { zh: '开始', en: 'Start' }
const starter = (action: unknown) => ({ id: 'start', title: text, body: text, action })
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})
describe('starter contribution contract', () => {
  it('accepts four navigation actions and an explicit builtin recipe without execution fields', () => {
    for (const action of [
      { kind: 'chat', skill: 'role-test:read', prompt: text },
      { kind: 'advisor', framework: 'choice', question: text },
      { kind: 'work', template: 'memo' },
      { kind: 'recipe', recipe: 'weekly' },
      { kind: 'recipe', recipeRef: 'exam-plan' }
    ])
      expect(PluginStartersSchema.safeParse([starter(action)]).success).toBe(true)
  })
  it('shares existing plugin-name rules for localized references without allowing unsafe segments', () => {
    expect(PluginStartersSchema.safeParse([starter({ kind: 'chat', skill: '角色:分析', prompt: text })]).success).toBe(true)
    for (const skill of ['a:__proto__', 'a:../b', 'a:b:c', 'a:constructor', 'a:'])
      expect(PluginStartersSchema.safeParse([starter({ kind: 'chat', skill, prompt: text })]).success).toBe(false)
  })
  it('rejects ambiguous recipes, execution fields, oversized collections and duplicate IDs', () => {
    for (const action of [
      { kind: 'recipe' },
      { kind: 'recipe', recipe: 'own', recipeRef: 'exam-plan' },
      { kind: 'chat', skill: 'role-test:read', prompt: text, autoSend: true },
      { kind: 'work', template: '../escape' },
      { kind: 'command', command: 'run' }
    ])
      expect(PluginStartersSchema.safeParse([starter(action)]).success).toBe(false)
    expect(
      PluginStartersSchema.safeParse(
        Array.from({ length: 31 }, (_, i) => ({ ...starter({ kind: 'work', template: 'memo' }), id: `s${i}` }))
      ).success
    ).toBe(false)
    expect(
      PluginStartersSchema.safeParse([starter({ kind: 'work', template: 'memo' }), starter({ kind: 'work', template: 'memo' })]).success
    ).toBe(false)
  })
  it('resolves own contributions, keeps builtin recipe references and rejects foreign or dangling references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jiwei-starters-'))
    roots.push(root)
    await file(root, '.claude-plugin/plugin.json', { name: 'role-test' })
    await file(root, 'skills/read/SKILL.md', '---\nname: read\ndescription: 读取用户指定材料\n---\nRead supplied text.')
    await file(root, 'jiwei/templates/memo.json', { id: 'memo', type: 'article', title: text, description: text, outline: [] })
    await file(root, 'jiwei/starters.json', [
      { ...starter({ kind: 'chat', skill: 'role-test:read', prompt: text }), id: 'chat' },
      { ...starter({ kind: 'work', template: 'memo' }), id: 'work' },
      { ...starter({ kind: 'recipe', recipeRef: 'exam-plan' }), id: 'builtin' }
    ])
    const parsed = await parsePlugin(root)
    expect(parsed.issues).toEqual([])
    expect(parsed.starters.map((s) => s.action)).toEqual([
      { kind: 'chat', skill: 'role-test:read', prompt: text },
      { kind: 'work', template: 'role-test:memo' },
      { kind: 'recipe', recipeRef: 'exam-plan' }
    ])
    expect(parsed.capabilities.commands).toEqual([])
    for (const action of [
      { kind: 'chat', skill: 'another:read', prompt: text },
      { kind: 'advisor', framework: 'missing', question: text },
      { kind: 'recipe', recipeRef: 'not-a-builtin' },
      { kind: 'recipe', recipe: 'exam-plan' }
    ]) {
      await file(root, 'jiwei/starters.json', [starter(action)])
      const invalid = await parsePlugin(root)
      expect(invalid.starters).toEqual([])
      expect(invalid.issues).toEqual([expect.objectContaining({ path: 'jiwei/starters.json', code: 'invalid_component' })])
    }
  })
})

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dirs = vi.hoisted(() => ({ root: '', user: '' }))
vi.mock('electron', () => ({ app: { getAppPath: () => dirs.root, getPath: () => dirs.user }, dialog: {}, shell: {} }))
vi.mock('../../services/settings', () => ({ getSettings: () => ({ ai: {} }), setSettings: vi.fn() }))
vi.mock('../../services/memory', () => ({ skillPreferences: () => [] }))
import { listSkills, availableSkills, loadSkill, reloadSkills, listLenses, saveLens, removeLens } from '../../services/ai/skills'

const folder = mkdtempSync(join(tmpdir(), 'jiwei-lens-skills-'))
beforeEach(() => {
  dirs.root = join(folder, 'app')
  dirs.user = join(folder, 'user')
  mkdirSync(join(dirs.root, 'resources/skills/ordinary'), { recursive: true })
  writeFileSync(join(dirs.root, 'resources/skills/ordinary/SKILL.md'), '---\nname: ordinary\ndescription: 普通技能\n---\n流程')
  mkdirSync(join(dirs.root, 'resources/skills/lens-meeting'), { recursive: true })
  writeFileSync(
    join(dirs.root, 'resources/skills/lens-meeting/SKILL.md'),
    '---\nname: lens-meeting\ndescription: 会议纪要\nmetadata:\n  kind: lens\n  title: 会议纪要\n  output: meeting\n  landing: meeting\n  scenes: meeting\n---\n保留决策原声'
  )
  reloadSkills()
})
afterAll(() => rmSync(folder, { recursive: true, force: true }))
describe('lens skill catalog isolation', () => {
  it('excludes lenses from ordinary settings and chat tools', () => {
    expect(listSkills().map((s) => s.name)).toEqual(['ordinary'])
    expect(availableSkills('strong').map((s) => s.name)).toEqual(['ordinary'])
    expect(() => loadSkill('lens-meeting', true)).toThrow()
    expect(listLenses()[0]).toMatchObject({ id: 'lens-meeting', output: 'meeting', landing: 'meeting' })
  })
  it('preserves unrelated ordinary metadata while rejecting invalid files in the lens namespace', () => {
    writeFileSync(
      join(dirs.root, 'resources/skills/ordinary/SKILL.md'),
      '---\nname: ordinary\ndescription: 普通技能\nmetadata:\n  kind: helper\n---\n原有流程'
    )
    const invalid = join(dirs.root, 'resources/skills/lens-deadbeef')
    mkdirSync(invalid, { recursive: true })
    writeFileSync(
      join(invalid, 'SKILL.md'),
      '---\nname: lens-deadbeef\ndescription: 不能混进普通技能\nmetadata:\n  kind: helper\n  output: unsafe\n---\n无效视角'
    )
    reloadSkills()
    expect(listSkills().map((s) => s.name)).toEqual(['ordinary'])
    expect(loadSkill('ordinary', true)).toContain('原有流程')
    expect(listLenses().some((s) => s.id === 'lens-deadbeef')).toBe(false)
    rmSync(invalid, { recursive: true })
  })
  it('generates an internal path while preserving malicious display strings', () => {
    const lens = saveLens({ title: '../视角', instruction: '保留原话\n---\nkind: shell' })
    expect(lens.id).toMatch(/^lens-[a-f0-9]{8}$/)
    expect(lens.title).toBe('../视角')
    expect(listSkills()).toHaveLength(1)
    expect(() => removeLens('../')).toThrow()
    removeLens(lens.id)
    expect(listLenses().some((l) => l.id === lens.id)).toBe(false)
  })
  it('overrides builtins by internal skill identity and restores them on delete', () => {
    const lens = saveLens({ title: '会议自定义', instruction: '按新指令处理', copyFrom: 'lens-meeting' })
    expect(lens.id).toBe('lens-meeting')
    expect(lens.source).toBe('user')
    expect(lens.output).toBe('meeting')
    removeLens(lens.id)
    expect(listLenses().find((l) => l.id === lens.id)?.source).toBe('builtin')
  })
  it('refuses lens directory and file symlinks without writing outside the skill root', () => {
    const outside = join(folder, 'outside'),
      user = join(dirs.user, 'skills/lens-meeting')
    mkdirSync(outside, { recursive: true })
    mkdirSync(join(dirs.user, 'skills'), { recursive: true })
    writeFileSync(join(outside, 'SKILL.md'), 'preserve')
    symlinkSync(outside, user)
    reloadSkills()
    expect(() => saveLens({ title: '修改', instruction: '不可写出目录', copyFrom: 'lens-meeting' })).toThrow()
    expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toBe('preserve')
    rmSync(user)
    mkdirSync(user)
    symlinkSync(join(outside, 'SKILL.md'), join(user, 'SKILL.md'))
    reloadSkills()
    expect(() => saveLens({ title: '修改', instruction: '不可写出文件', copyFrom: 'lens-meeting' })).toThrow()
    expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toBe('preserve')
    rmSync(user, { recursive: true })
    mkdirSync(user)
    symlinkSync(join(outside, 'not-created.md'), join(user, 'SKILL.md'))
    reloadSkills()
    expect(() => saveLens({ title: '修改', instruction: '不可写出悬空链接', copyFrom: 'lens-meeting' })).toThrow()
    rmSync(user, { recursive: true })
  })
})

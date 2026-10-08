import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { parseSkill } from '../skillFormat'

const dir = join(__dirname, '../../../../resources/skills')

describe('parseSkill', () => {
  it('parses frontmatter, metadata and body', () => {
    const s = parseSkill('---\nname: demo-skill\ndescription: 示例\nmetadata:\n  title: 示例技能\n  min-model: strong\n---\n\n# 正文\n')
    expect(s).toMatchObject({
      name: 'demo-skill',
      description: '示例',
      metadata: { title: '示例技能', 'min-model': 'strong' },
      body: '# 正文'
    })
  })

  it('rejects invalid names, missing frontmatter and folder mismatch', () => {
    expect(() => parseSkill('# no frontmatter')).toThrow()
    expect(() => parseSkill('---\nname: Bad_Name\ndescription: x\n---\n')).toThrow()
    expect(() => parseSkill('---\nname: ok\ndescription: x\n---\n', 'other')).toThrow()
    expect(() => parseSkill('---\nname: ok\n---\n')).toThrow()
  })

  it('every built-in skill is valid', () => {
    const names = readdirSync(dir)
    expect(names.length).toBeGreaterThanOrEqual(7)
    for (const n of names) {
      const s = parseSkill(readFileSync(join(dir, n, 'SKILL.md'), 'utf8'), n)
      expect(s.metadata.title, n).toBeTruthy()
      expect(s.body.length, n).toBeGreaterThan(200)
    }
  })
})

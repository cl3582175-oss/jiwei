import { describe, expect, it } from 'vitest'
import { ProjectCreateSchema, ProjectUpdateSchema } from '../chatProjects'

describe('project configuration contracts', () => {
  it('requires a visible name and bounds user instructions', () => {
    expect(ProjectCreateSchema.safeParse({ name: '  ' }).success).toBe(false)
    expect(ProjectCreateSchema.safeParse({ name: '名'.repeat(61) }).success).toBe(false)
    expect(ProjectUpdateSchema.safeParse({ instructions: '文'.repeat(4001) }).success).toBe(false)
    expect(ProjectCreateSchema.parse({ name: ' 项目 ' })).toMatchObject({ name: '项目', memory: 'default', libraryScope: 'all' })
  })
})

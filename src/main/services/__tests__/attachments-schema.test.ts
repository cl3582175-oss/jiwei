import { expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import * as schema from '../../db/schema'

it('资料默认进入资料库，附件关系保存对话身份和首次发送状态', () => {
  const cols = getTableColumns(schema.sources) as Record<string, { default?: unknown }>
  expect(cols.space?.default).toBe('library')
  expect('conversationAttachments' in schema).toBe(true)
})

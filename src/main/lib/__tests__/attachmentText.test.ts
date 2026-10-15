import { expect, it } from 'vitest'
import { htmlBlocks } from '../../../worker/htmlBlocks'
import { chunkBlocks } from '../chunker'
import { tablePreview } from '../attachmentText'
import type { Segment } from '@shared/types'

it.each(['colspan', 'rowspan'])('limits actual structured %s table data to 200 rows across chunks', (span) => {
  const rows = Array.from(
    { length: 240 },
    (_, i) =>
      `<tr>${span === 'rowspan' ? (i ? '' : '<td rowspan="240">合成组</td>') : ''}<td${span === 'colspan' ? ' colspan="2"' : ''}>ROW_${String(i + 1).padStart(3, '0')}</td></tr>`
  )
  const blocks = htmlBlocks(`<table><tr><th colspan="2">合成字段</th></tr>${rows.join('')}</table>`)
  const segments: Segment[] = chunkBlocks(blocks, { locatorOf: () => ({ type: 'FragmentSelector', value: 'block=0' }) }).map(
    (c, ordinal) => ({ ...c, id: String(ordinal), sourceId: 'synthetic', ordinal })
  )
  expect(segments.map((s) => s.text).join('\n')).toContain('ROW_240')
  const preview = tablePreview(segments)
    .map((s) => s.text)
    .join('\n')
  expect(preview).toContain('合成字段')
  expect(preview).toContain('ROW_200')
  expect(preview).not.toContain('ROW_201')
  expect(preview).not.toContain('ROW_240')
  expect(preview).toContain('共 240 行数据')
  expect(preview).not.toContain('仅提供表头')
})

it('does not treat unknown unstructured table data as a header', () => {
  const [preview] = tablePreview([{ id: 's', sourceId: 'source', ordinal: 0, kind: 'table', locator: {}, text: 'ROW_240\nprivate value' }])
  expect(preview.text).not.toContain('ROW_240')
  expect(preview.text).not.toContain('private value')
  expect(preview.text).toContain('行序数未知')
})

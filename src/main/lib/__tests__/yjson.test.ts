import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import { jsonToYState } from '../yjson'
import { sampleNote } from '../sampleNote'
import { DOC_FIELD, type DocJSON } from '@shared/types'

function roundTrip(doc: DocJSON): DocJSON {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, jsonToYState(doc))
  return yDocToProsemirrorJSON(ydoc, DOC_FIELD) as DocJSON
}

describe('jsonToYState', () => {
  it('keeps text order and marks across mixed runs', () => {
    const out = roundTrip({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '复习时', marks: [{ type: 'bold' }] },
            { type: 'text', text: '遮住右边。' },
            { type: 'text', text: '重点', marks: [{ type: 'italic' }] }
          ]
        }
      ]
    })
    const runs = out.content![0].content!
    expect(runs.map((r) => r.text)).toEqual(['复习时', '遮住右边。', '重点'])
    expect(runs[0].marks?.[0].type).toBe('bold')
    expect(runs[1].marks ?? []).toEqual([])
    expect(runs[2].marks?.[0].type).toBe('italic')
  })

  it('assigns ids to block nodes', () => {
    const out = roundTrip(sampleNote('zh-CN').doc)
    const row = out.content![0]
    expect(row.type).toBe('cornellRow')
    expect(typeof row.attrs?.id).toBe('string')
    expect(out.content!.at(-1)!.type).toBe('cornellSummary')
  })
})

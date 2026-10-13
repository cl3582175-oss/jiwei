import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { AllSelection, EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { CornellDocument, CornellRow, CornellCue, CornellBody, CornellSummary, selectCornellContent } from '../cornell'

const schema = getSchema([
  StarterKit.configure({ document: false }),
  Image,
  TableKit,
  CornellDocument,
  CornellRow,
  CornellCue,
  CornellBody,
  CornellSummary
])
const p = (text: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined)
const row = (body = [p('first')]) =>
  schema.nodes.cornellRow.create(null, [schema.nodes.cornellCue.create(null, p('cue')), schema.nodes.cornellBody.create(null, body)])
const doc = (body?: ReturnType<typeof p>[]) =>
  schema.nodes.doc.create(null, [row(body), row([p('second')]), schema.nodes.cornellSummary.create(null, p('summary'))])
function press(state: EditorState): EditorState {
  let tr: Transaction | undefined
  expect(
    selectCornellContent(state, (next) => {
      tr = next
    })
  ).toBe(true)
  return state.apply(tr!)
}
function atText(text: string, document = doc()): EditorState {
  let at = -1
  document.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === text) at = pos
  })
  return EditorState.create({ schema, doc: document, selection: TextSelection.create(document, at) })
}

describe('Cornell local select all', () => {
  it('selects one body then the document', () => {
    let state = press(atText('first'))
    expect(state.selection).toBeInstanceOf(TextSelection)
    expect([state.selection.from, state.selection.to]).toEqual([10, 15])
    expect(state.selection.content().content.textBetween(0, state.selection.content().content.size)).toBe('first')
    state = press(state)
    expect(state.selection).toBeInstanceOf(AllSelection)
  })
  it.each(['cue', 'first', 'summary'])('deletes only %s and keeps both rows and summary', (text) => {
    const state = press(atText(text))
    const next = state.apply(state.tr.deleteSelection())
    expect(next.doc.childCount).toBe(3)
    const cleared = text === 'summary' ? next.doc.lastChild! : next.doc.child(0).child(text === 'cue' ? 0 : 1)
    expect(cleared.textContent).toBe('')
    expect(next.doc.textContent).toContain('second')
    next.doc.check()
  })
  it('expands from table cell to Cornell body to document', () => {
    const cell = (text: string) => schema.nodes.tableCell.create(null, p(text))
    const table = schema.nodes.table.create(null, schema.nodes.tableRow.create(null, [cell('A'), cell('B')]))
    let state = press(atText('A', doc([table, p('tail')])))
    expect(state.selection.content().content.textBetween(0, state.selection.content().content.size)).toBe('A')
    state = press(state)
    expect(state.selection.content().content.textBetween(0, state.selection.content().content.size)).toContain('tail')
    expect(state.selection.content().content.textBetween(0, state.selection.content().content.size)).not.toContain('second')
    state = press(state)
    expect(state.selection).toBeInstanceOf(AllSelection)
  })
  it('expands code block then body then document', () => {
    const block = schema.nodes.codeBlock.create(null, schema.text('code'))
    let state = press(atText('code', doc([block, p('tail')])))
    expect(state.selection.to - state.selection.from).toBe(4)
    state = press(state)
    expect(state.selection.content().content.textBetween(0, state.selection.content().content.size)).toContain('tail')
    expect(press(state).selection).toBeInstanceOf(AllSelection)
  })
  it('includes boundary image and table blocks; delete and input retain an empty valid grid', () => {
    const image = schema.nodes.image.create({ src: 'jiwei://asset/test.png' })
    const table = schema.nodes.table.create(null, schema.nodes.tableRow.create(null, schema.nodes.tableCell.create(null, p('table'))))
    const state = press(atText('middle', doc([image, p('middle'), table])))
    const copied = state.selection.content().content
    expect(copied.firstChild?.type.name).toBe('image')
    expect(copied.lastChild?.type.name).toBe('table')
    const deleted = state.apply(state.tr.deleteSelection())
    expect(deleted.doc.child(0).child(1).toJSON()).toEqual({ type: 'cornellBody', content: [{ type: 'paragraph' }] })
    expect(deleted.doc.child(1).textContent).toBe('cuesecond')
    const replaced = state.apply(state.tr.insertText('replacement'))
    expect(replaced.doc.child(0).child(1).textContent).toBe('replacement')
    expect(replaced.doc.child(1).textContent).toBe('cuesecond')
    deleted.doc.check()
    replaced.doc.check()
  })
})

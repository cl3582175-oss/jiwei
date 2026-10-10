import * as Y from 'yjs'
import { isDeepStrictEqual } from 'util'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db'
import { derivationLandings, derivations, actions, insights, proposals, sources } from '../db/schema'
import { LensLand, LensReviewed, lensParagraph, type Landing, type LandingObject, type LensItem, type LensOrigin } from '@shared/lens'
import type { DocJSON, DocNode, Proposal } from '@shared/types'
import { newId } from '../lib/ids'
import { canUndoLanding, duplicateLensItems, mapLensLanding } from '../lib/lensLanding'
import { getDerivation } from './lenses'
import { ensureRecordingMetadata, lensMessage, transcriptRevision, requireLensCloud } from './recordingContext'
import { lensDate, relativeLensDate } from '../lib/lensDates'
import { createNote, getNote, trashNote } from './notes'
import { createProposal, listProposals, resolveOp } from './proposals'
import { listPeople, savePerson } from './people'
import { loadDoc, pushUpdate, stateToJSON } from './docs'
import { createAction, createLensInsight, updateAction } from './reflection'
import { recordConcept } from './learner'
import { listSeries } from './series'
import { deviceId } from './device'
import { emit } from '../events'

type Row = typeof derivationLandings.$inferSelect
const raw = (id: string): Row => {
  const r = getDb().select().from(derivationLandings).where(eq(derivationLandings.id, id)).get()
  if (!r) throw new Error(lensMessage('landing'))
  return r
}
const patch = (id: string, set: Partial<Row>): void => {
  getDb()
    .update(derivationLandings)
    .set({ ...set, updatedAt: Date.now(), updatedBy: deviceId() })
    .where(eq(derivationLandings.id, id))
    .run()
}
const objectRow = (kind: LandingObject['kind'], id: string): unknown =>
  kind === 'action' || kind === 'progress'
    ? getDb().select().from(actions).where(eq(actions.id, id)).get()
    : kind === 'insight'
      ? getDb().select().from(insights).where(eq(insights.id, id)).get()
      : null
function proposalNodes(doc: DocJSON, proposalId: string): DocNode[] {
  const nodes: DocNode[] = []
  const walk = (node: DocNode): void => {
    try {
      const o = JSON.parse(String(node.attrs?.origin)) as { proposalId?: string }
      if (o.proposalId === proposalId) {
        nodes.push(node)
        return
      }
    } catch {
      /* 原有内容没有提案身份 */
    }
    node.content?.forEach(walk)
  }
  doc.content?.forEach(walk)
  return nodes
}
function findNode(doc: DocJSON, id: string): DocNode | null {
  let found: DocNode | null = null
  const walk = (n: DocNode): void => {
    if (n.attrs?.id === id) found = n
    else n.content?.forEach(walk)
  }
  doc.content?.forEach(walk)
  return found
}
function intact(row: Row): boolean {
  const objects = JSON.parse(row.objects) as LandingObject[],
    blocks = JSON.parse(row.blocks) as Landing['blocks']
  if (
    objects.some((o) => {
      if (o.kind === 'concept' || o.kind === 'note') return false
      if (o.kind === 'person') {
        const p = listPeople().find((p) => p.id === o.id)
        const snapshot = JSON.parse(o.snapshot) as { before: string; after: string }
        return p?.note !== snapshot.after && !(row.status === 'undoing' && p?.note === snapshot.before)
      }
      if (o.kind === 'progress') return JSON.stringify(objectRow(o.kind, o.id)) !== (JSON.parse(o.snapshot) as { after: string }).after
      return JSON.stringify(objectRow(o.kind, o.id)) !== o.snapshot
    })
  )
    return false
  if (row.noteId && blocks.length) {
    const doc = stateToJSON(loadDoc(row.noteId))
    if (blocks.some((b) => JSON.stringify(findNode(doc, b.id)) !== b.snapshot)) return false
  }
  return true
}
const toLanding = (r: Row): Landing => ({
  ...r,
  items: JSON.parse(r.items),
  objects: JSON.parse(r.objects),
  blocks: JSON.parse(r.blocks),
  canUndo: r.status === 'applied' && r.appliedAt !== null && canUndoLanding(r.appliedAt, Date.now(), intact(r))
})
export function listLandings(derivationId: string): Landing[] {
  return getDb()
    .select()
    .from(derivationLandings)
    .where(and(eq(derivationLandings.derivationId, derivationId), isNull(derivationLandings.deletedAt)))
    .orderBy(desc(derivationLandings.createdAt))
    .all()
    .map(toLanding)
}
export function duplicates(derivationId: string): string[] {
  const d = getDerivation(derivationId),
    ids = new Set(
      getDb()
        .select({ id: derivations.id })
        .from(derivations)
        .where(eq(derivations.sourceId, d.sourceId))
        .all()
        .map((d) => d.id)
    )
  const existing = getDb()
    .select()
    .from(derivationLandings)
    .where(eq(derivationLandings.status, 'applied'))
    .all()
    .filter((l) => ids.has(l.derivationId))
    .flatMap((l) => JSON.parse(l.items) as LensItem[])
  return duplicateLensItems(d.result?.items ?? [], existing)
}
const titleFor = (d: ReturnType<typeof getDerivation>, date: string): string => {
  const sourceTitle = getDb().select({ title: sources.title }).from(sources).where(eq(sources.id, d.sourceId)).get()?.title ?? d.lensTitle
  if (d.landing === 'meeting') return `会议：${d.result?.items.find((i) => i.category === 'topic')?.body || sourceTitle}（${date}）`
  if (d.landing === 'lecture') {
    const course = d.result?.course?.trim() || sourceTitle,
      lecture = d.result?.lecture?.trim()
    return `${course}${lecture ? ` · ${lecture}` : ''}（${date}）`
  }
  return `${d.landing === 'thought' ? '随想：' : ''}${sourceTitle}（${date}）`
}
export function prepare(input: z.infer<typeof LensLand>): Landing {
  input = LensLand.parse(input)
  const d = getDerivation(input.derivationId)
  requireLensCloud(d.sourceId)
  if (d.status !== 'ready' || !d.result || d.transcriptRevision !== transcriptRevision(d.sourceId)) throw new Error(lensMessage('changed'))
  const existing = listLandings(d.id),
    pending = existing.find((l) => l.status === 'pending')
  const settled = new Set(existing.filter((l) => ['applied', 'undoing'].includes(l.status)).flatMap((l) => l.items.map((i) => i.id))),
    seen = new Set<string>(),
    persons = listPeople()
  const items: LensItem[] = input.items.flatMap((reviewed) => {
    const original = d.result!.items.find((i) => i.id === reviewed.id)
    if (!original || !original.evidence.length || settled.has(original.id) || seen.has(original.id)) return []
    seen.add(original.id)
    const item = { ...original, ...reviewed },
      owner = persons.find((p) => p.id === item.ownerPersonId)
    if (reviewed.ownerPersonId && !owner) throw new Error(lensMessage('person'))
    item.ownerPersonId = owner?.id ?? null
    item.ownerName = owner?.name ?? item.ownerName
    if (item.dueDate && relativeLensDate(item.dueDate, item.dueDate) !== item.dueDate) throw new Error(lensMessage('date'))
    if (item.noteId && !d.result!.noteCandidates.some((n) => n.id === item.noteId)) delete item.noteId
    if (item.actionId && !d.result!.actionCandidates.some((a) => a.id === item.actionId)) delete item.actionId
    return [item]
  })
  if (!items.length) throw new Error(lensMessage('empty'))
  if (pending) {
    const canonical = (items: LensItem[]): string => JSON.stringify(items.map((i) => JSON.stringify(LensReviewed.parse(i))).sort()),
      createdNote = pending.objects.some((o) => o.kind === 'note'),
      person = pending.objects.find((o) => o.kind === 'person')
    if (
      canonical(items) !== canonical(pending.items) ||
      (pending.noteId && input.noteId !== pending.noteId && !(createdNote && input.noteId === null)) ||
      (person && (input.personId ?? d.params.personId) !== person.id)
    )
      throw new Error(lensMessage('pendingReview'))
    return pending
  }
  const recording = ensureRecordingMetadata(d.sourceId),
    date = lensDate(recording.startedAt),
    mapping = mapLensLanding(d.landing, items, d.result.sentences, d.sourceId, date),
    id = newId(),
    now = Date.now(),
    objects: LandingObject[] = []
  let noteId: string | null = null,
    proposalId: string | null = null
  getDb().transaction(() => {
    if (mapping.ops.length) {
      const categoryId = listSeries().find((s) => s.id === recording.seriesId)?.categoryId ?? null
      const note = input.noteId ? getNote(input.noteId) : createNote({ title: titleFor(d, date).slice(0, 500), categoryId })
      if (!note || note.deletedAt || note.aiExcluded || note.kind !== 'cornell') throw new Error(lensMessage('note'))
      noteId = note.id
      if (!input.noteId)
        objects.push({
          kind: 'note',
          id: note.id,
          itemId: '',
          snapshot: JSON.stringify({ title: note.title, categoryId: note.categoryId })
        })
      const segmentIds = items.flatMap((i) =>
        i.evidence.map((ref) => d.result!.sentences.find((s) => s.ref === ref)?.segmentId).filter((id): id is string => !!id)
      )
      const p = createProposal({
        noteId: note.id,
        title: d.lensTitle,
        ops: mapping.ops,
        model: d.model,
        auto: false,
        skill: 'lens-landing',
        sources: [{ type: 'source', id: d.sourceId }, ...segmentIds.map((id) => ({ type: 'segment' as const, id }))]
      })
      proposalId = p.id
    }
    if (mapping.personNotes.length) {
      const personId = input.personId ?? d.params.personId,
        person = persons.find((p) => p.id === personId)
      if (!person) throw new Error(lensMessage('person'))
      objects.push({
        kind: 'person',
        id: person.id,
        itemId: '',
        snapshot: JSON.stringify({ before: person.note, after: person.note + '\n' + mapping.personNotes.map((i) => i.body).join('\n') })
      })
    }
    getDb()
      .insert(derivationLandings)
      .values({
        id,
        derivationId: d.id,
        noteId,
        proposalId,
        status: 'pending',
        items: JSON.stringify(items),
        objects: JSON.stringify(objects),
        createdAt: now,
        updatedAt: now,
        updatedBy: deviceId()
      })
      .run()
  })
  return toLanding(raw(id))
}
function mergedDoc(noteId: string, update: Uint8Array): DocJSON {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, loadDoc(noteId))
    Y.applyUpdate(doc, update)
    return stateToJSON(Y.encodeStateAsUpdate(doc))
  } finally {
    doc.destroy()
  }
}
const strip = (node: DocNode): DocNode => {
  const attrs = Object.fromEntries(
    Object.entries(node.attrs ?? {}).filter(([key, value]) => !['id', 'origin'].includes(key) && value !== null && value !== undefined)
  )
  return {
    type: node.type,
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(node.marks?.length
      ? { marks: node.marks.map((m) => ({ type: m.type, attrs: m.type === 'link' ? { href: m.attrs?.href } : (m.attrs ?? {}) })) }
      : {}),
    ...(node.content?.length ? { content: node.content.map(strip) } : {})
  }
}
function verifyApplied(doc: DocJSON, proposal: Proposal): DocNode[] {
  const nodes = proposalNodes(doc, proposal.id)
  if (nodes.length !== proposal.ops.length) throw new Error(lensMessage('unapplied'))
  for (const [i, op] of proposal.ops.entries()) {
    const actual = nodes.filter((n) => {
      try {
        return (JSON.parse(String(n.attrs?.origin)) as { opIndex: number }).opIndex === i
      } catch {
        return false
      }
    })
    const expected =
      op.op === 'insert_row'
        ? [
            {
              type: 'cornellRow',
              content: [
                { type: 'cornellCue', content: op.cue },
                { type: 'cornellBody', content: op.body }
              ]
            }
          ]
        : op.op === 'append_summary'
          ? op.nodes
          : []
    if (!isDeepStrictEqual(actual.map(strip), expected.map(strip))) throw new Error(lensMessage('unapplied'))
  }
  return nodes
}
export function complete(id: string, update: Uint8Array): Landing {
  const row = raw(id)
  if (row.status === 'applied') return toLanding(row)
  if (row.status !== 'pending') throw new Error(lensMessage('landing'))
  const d = getDerivation(row.derivationId),
    items = JSON.parse(row.items) as LensItem[],
    record = ensureRecordingMetadata(d.sourceId)
  requireLensCloud(d.sourceId)
  if (row.noteId) {
    const note = getNote(row.noteId)
    if (!note || note.deletedAt || note.aiExcluded) throw new Error(lensMessage('note'))
  }
  if (!d.result || d.transcriptRevision !== transcriptRevision(d.sourceId)) throw new Error(lensMessage('changed'))
  let p: Proposal | undefined,
    blocks: Landing['blocks'] = []
  if (row.noteId && row.proposalId) {
    p = listProposals(row.noteId).find((p) => p.id === row.proposalId)
    if (!p) throw new Error(lensMessage('unapplied'))
    blocks = verifyApplied(mergedDoc(row.noteId, update), p).map((n) => ({ id: String(n.attrs?.id), snapshot: JSON.stringify(n) }))
  }
  const mapping = mapLensLanding(d.landing, items, d.result.sentences, d.sourceId, lensDate(record.startedAt)),
    objects = JSON.parse(row.objects) as LandingObject[]
  // 个人库没有跨库事务；以每条落地身份做现有概念信号去重，崩溃重试不会重复加分。
  for (const item of mapping.concepts) {
    const c = recordConcept(
      item.title,
      'asked',
      { conversationId: `lens:${id}:${item.id}`, note: JSON.stringify({ derivationId: d.id, itemId: item.id, sourceId: d.sourceId }) },
      { silent: true }
    )
    if (c) objects.push({ kind: 'concept', id: c.id, itemId: item.id, snapshot: '' })
  }
  for (const o of objects.filter((o) => o.kind === 'person')) {
    const person = listPeople().find((p) => p.id === o.id),
      s = JSON.parse(o.snapshot) as { before: string; after: string }
    if (!person || (person.note !== s.before && person.note !== s.after)) throw new Error(lensMessage('modified'))
    if (s.after.length > 2000) throw new Error(lensMessage('personNote'))
    savePerson({ ...person, note: s.after }, person.id)
  }
  getDb().transaction(() => {
    if (row.noteId && p) {
      pushUpdate(row.noteId, update)
      p.ops.forEach((_, i) =>
        resolveOp(
          p!.id,
          i,
          'accepted',
          blocks.map((b) => b.id)
        )
      )
    }
    const origin = (item: LensItem): LensOrigin => ({
      derivationId: d.id,
      itemId: item.id,
      sourceId: d.sourceId,
      t: d.result!.sentences.find((s) => s.ref === item.evidence[0])?.start ?? 0
    })
    for (const item of mapping.actions) {
      const action = createAction(item.body, item.dueDate ? new Date(`${item.dueDate}T12:00:00`).getTime() : null, null, {
        ownerPersonId: item.ownerPersonId,
        ownerName: item.ownerName,
        origin: origin(item)
      })
      objects.push({ kind: 'action', id: action.id, itemId: item.id, snapshot: JSON.stringify(objectRow('action', action.id)) })
    }
    for (const item of mapping.insights) {
      const insight = createLensInsight(item.body, origin(item))
      objects.push({ kind: 'insight', id: insight.id, itemId: item.id, snapshot: JSON.stringify(objectRow('insight', insight.id)) })
    }
    const completed = new Set<string>()
    for (const item of mapping.progress) {
      if (
        !item.completeAction ||
        !item.actionId ||
        completed.has(item.actionId) ||
        !d.result!.actionCandidates.some((a) => a.id === item.actionId)
      )
        continue
      const before = objectRow('action', item.actionId) as typeof actions.$inferSelect | undefined
      if (!before || before.deletedAt || before.status === 'done') continue
      completed.add(item.actionId)
      updateAction(item.actionId, { status: 'done' })
      objects.push({
        kind: 'progress',
        id: item.actionId,
        itemId: item.id,
        snapshot: JSON.stringify({ before, after: JSON.stringify(objectRow('action', item.actionId)) })
      })
    }
    patch(id, { status: 'applied', objects: JSON.stringify(objects), blocks: JSON.stringify(blocks), appliedAt: Date.now() })
  })
  if (row.noteId) emit('docs:updated', { noteId: row.noteId, update })
  emit('lenses:changed', { sourceId: d.sourceId })
  emit('memory:changed', {})
  emit('reflection:changed', {})
  return toLanding(raw(id))
}
export function undo(id: string): Landing {
  const row = raw(id)
  if (row.status === 'undoing') return toLanding(row)
  if (row.status !== 'applied' || row.appliedAt === null || !canUndoLanding(row.appliedAt, Date.now(), intact(row)))
    throw new Error(lensMessage('undo'))
  let undoProposalId: string | null = null
  getDb().transaction(() => {
    if (row.noteId) {
      const blocks = JSON.parse(row.blocks) as Landing['blocks'],
        doc = stateToJSON(loadDoc(row.noteId)),
        rowCount = doc.content?.filter((n) => n.type === 'cornellRow').length ?? 0
      let rows = rowCount
      const ops: Proposal['ops'] = blocks.map((b) => {
        const node = findNode(doc, b.id)!
        if (node.type === 'cornellRow' && --rows < 1)
          return {
            op: 'replace_block',
            blockId: b.id,
            nodes: [
              {
                type: 'cornellRow',
                content: [
                  { type: 'cornellCue', content: [lensParagraph('')] },
                  { type: 'cornellBody', content: [lensParagraph('')] }
                ]
              }
            ]
          }
        return { op: 'delete_block', blockId: b.id }
      })
      if (ops.length)
        undoProposalId = createProposal({
          noteId: row.noteId,
          title: lensMessage('undoTitle'),
          ops,
          auto: false,
          skill: 'lens-landing',
          sources: [{ type: 'source', id: getDerivation(row.derivationId).sourceId }]
        }).id
    }
    patch(id, { status: 'undoing', undoProposalId })
  })
  return toLanding(raw(id))
}
export function undoComplete(id: string, update: Uint8Array): Landing {
  const row = raw(id)
  if (row.status === 'undone') return toLanding(row)
  if (row.status !== 'undoing' || row.appliedAt === null || !canUndoLanding(row.appliedAt, Date.now(), intact(row)))
    throw new Error(lensMessage('undo'))
  let p: Proposal | undefined
  if (row.noteId && row.undoProposalId) {
    p = listProposals(row.noteId).find((p) => p.id === row.undoProposalId)
    if (!p || proposalNodes(mergedDoc(row.noteId, update), row.proposalId!).length) throw new Error(lensMessage('unapplied'))
  }
  const objects = JSON.parse(row.objects) as LandingObject[]
  for (const o of objects.filter((o) => o.kind === 'person')) {
    const person = listPeople().find((p) => p.id === o.id)!,
      snapshot = JSON.parse(o.snapshot) as { before: string }
    savePerson({ ...person, note: snapshot.before }, person.id)
  }
  getDb().transaction(() => {
    if (row.noteId && p) {
      pushUpdate(row.noteId, update)
      p.ops.forEach((_, i) => resolveOp(p!.id, i, 'accepted'))
    }
    const now = Date.now()
    for (const o of objects) {
      if (o.kind === 'action') getDb().update(actions).set({ deletedAt: now, updatedAt: now }).where(eq(actions.id, o.id)).run()
      if (o.kind === 'insight') getDb().update(insights).set({ deletedAt: now, updatedAt: now }).where(eq(insights.id, o.id)).run()
      if (o.kind === 'progress') {
        const before = (JSON.parse(o.snapshot) as { before: typeof actions.$inferSelect }).before
        getDb().update(actions).set({ status: before.status, doneAt: before.doneAt, updatedAt: now }).where(eq(actions.id, o.id)).run()
      }
      if (o.kind === 'note' && row.noteId) {
        const note = getNote(o.id),
          snapshot = JSON.parse(o.snapshot) as { title: string; categoryId: string | null },
          remaining = mergedDoc(row.noteId, update)
        if (note?.title === snapshot.title && note.categoryId === snapshot.categoryId && !JSON.stringify(remaining).match(/"text":/))
          trashNote(o.id)
      }
    }
    if (row.undoProposalId)
      getDb().update(proposals).set({ status: 'resolved', resolvedAt: now }).where(eq(proposals.id, row.undoProposalId)).run()
    patch(id, { status: 'undone' })
  })
  if (row.noteId) emit('docs:updated', { noteId: row.noteId, update })
  emit('lenses:changed', { sourceId: getDerivation(row.derivationId).sourceId })
  emit('reflection:changed', {})
  return toLanding(raw(id))
}

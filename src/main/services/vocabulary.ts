import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { and, eq, isNull } from 'drizzle-orm'
import * as Y from 'yjs'
import { DEFAULT_VOCAB_THRESHOLD, VocabularyInputSchema, WordSchema, ThresholdSchema, type VocabularyProfile, type VocabularySignal, type VocabularyHistory, type VocabularyLanding, type VocabularyInput } from '@shared/reading'
import type { DocNode, ProposalOp } from '@shared/types'
import { getProfileDb } from '../db/profile'
import { knownWords, vocabularyProfile } from '../db/personalSchema'
import { getDb } from '../db'
import { notes, proposals } from '../db/schema'
import { englishLemma, adjustVocabulary, type WordRanks } from '../lib/vocabulary'
import { listCategories, createCategory } from './categories'
import { createNote } from './notes'
import { createProposal, resolveOp } from './proposals'
import { loadDoc, pushUpdate, stateToJSON } from './docs'
import { recordConcept } from './learner'
import { emit } from '../events'
import { readingAccess, readingError } from './readingPrivacy'
import { saveTab } from './browser/pages'

let ranks: WordRanks | null = null
export function wordRanks(): WordRanks {
  if (!ranks) {
    const path = app.isPackaged ? join(process.resourcesPath,'wordfreq','en.json') : join(app.getAppPath(),'resources','wordfreq','en.json')
    ranks = JSON.parse(readFileSync(path,'utf8')) as Record<string,number>
  }
  return ranks
}
function row(): typeof vocabularyProfile.$inferSelect {
  const db = getProfileDb()
  db.insert(vocabularyProfile).values({id:'self'}).onConflictDoNothing().run()
  return db.select().from(vocabularyProfile).where(eq(vocabularyProfile.id,'self')).get()!
}
export function profile(): VocabularyProfile {
  const current = row()
  return {
    threshold:current.initialized?current.vocabThreshold:DEFAULT_VOCAB_THRESHOLD,initialized:current.initialized,
    history:JSON.parse(current.vocabHistory) as VocabularyHistory[],pendingSignals:(JSON.parse(current.pendingSignals) as VocabularySignal[]).length,
    knownWords:getProfileDb().select({word:knownWords.word}).from(knownWords).all().map((w)=>w.word)
  }
}
export function setThreshold(input: number): VocabularyProfile {
  const threshold = ThresholdSchema.parse(input), current = row(), history = JSON.parse(current.vocabHistory) as VocabularyHistory[]
  if (current.initialized && current.vocabThreshold !== threshold) history.push({at:Date.now(),before:current.vocabThreshold,after:threshold,recognized:0,queried:0,reason:'manual'})
  getProfileDb().update(vocabularyProfile).set({vocabThreshold:threshold,initialized:true,vocabHistory:JSON.stringify(history.slice(-200)),pendingSignals:'[]'}).where(eq(vocabularyProfile.id,'self')).run()
  emit('memory:changed',{})
  return profile()
}
function signal(kind: VocabularySignal['kind'], input: string): VocabularyProfile {
  const word = englishLemma(WordSchema.parse(input),wordRanks()), current = row(), rank = wordRanks()[word] ?? 50001
  if ((kind === 'recognized' && rank <= current.vocabThreshold) || (kind === 'queried' && rank > current.vocabThreshold)) return profile()
  const pending = JSON.parse(current.pendingSignals) as VocabularySignal[], history = JSON.parse(current.vocabHistory) as VocabularyHistory[]
  pending.push({kind,word,rank})
  const change = adjustVocabulary(current.vocabThreshold,pending)
  if (change.consumed) {
    history.push({at:Date.now(),before:current.vocabThreshold,after:change.threshold,recognized:change.recognized,queried:change.queried,reason:'signals'})
    pending.splice(0,change.consumed)
  }
  getProfileDb().update(vocabularyProfile).set({vocabThreshold:change.threshold,pendingSignals:JSON.stringify(pending),vocabHistory:JSON.stringify(history.slice(-200))}).where(eq(vocabularyProfile.id,'self')).run()
  emit('memory:changed',{})
  return profile()
}
export function recognize(input: string): VocabularyProfile {
  const word = englishLemma(WordSchema.parse(input),wordRanks()), db = getProfileDb()
  if (db.select().from(knownWords).where(eq(knownWords.word,word)).get()) return profile()
  db.insert(knownWords).values({word,addedAt:Date.now(),source:'recognize'}).onConflictDoNothing().run()
  return signal('recognized',word)
}
export function query(word: string): VocabularyProfile { return signal('queried',word) }

interface Receipt { input: VocabularyInput; url: string | null; word: string; rowId: string | null; created: boolean; completed?: boolean; conceptRecorded?: boolean }
const text = (node?: DocNode): string => node?.text ?? node?.content?.map((n)=>text(n)).join('') ?? ''
const paragraph = (value: string): DocNode & {type:string} => ({type:'paragraph',content:[{type:'text',text:value}]})
const sourceParagraph = (url: string | null): (DocNode & {type:string})[] => url ? [{type:'paragraph',content:[{type:'text',text:url,marks:[{type:'link',attrs:{href:url}}]}]}] : []
const languages: Record<string,string> = {en:'英语',fr:'法语',de:'德语',ja:'日语',ko:'韩语',es:'西班牙语',ru:'俄语',zh:'中文'}

/** 同一词仅有一行；新例句通过插入到原行正文末尾的提案追加。 */
export async function prepare(raw: VocabularyInput): Promise<VocabularyLanding> {
  let input = VocabularyInputSchema.parse(raw)
  const originalAccess=readingAccess(input.target)
  originalAccess.guard()
  if(input.target.kind==='browser') {
    const sourceId=await saveTab(input.target.id)
    originalAccess.guard()
    input={...input,target:{kind:'source',id:sourceId}}
  }
  const access = readingAccess(input.target), word = input.language.startsWith('en') ? englishLemma(input.word,wordRanks()) : input.word.toLowerCase()
  access.guard()
  const title = `生词本 · ${languages[input.language.split('-')[0]] ?? input.language}`
  const db = getDb()
  return db.transaction(() => {
    const category = listCategories('note').find((c)=>c.name==='生词本') ?? createCategory('note','生词本')
    const existing = db.select().from(notes).where(and(eq(notes.categoryId,category.id),eq(notes.title,title),isNull(notes.deletedAt))).get()
    const note = existing ?? createNote({title,categoryId:category.id,kind:'cornell'})
    if (note.aiExcluded) throw new Error(readingError('privacy'))
    const pending = db.select().from(proposals).where(and(eq(proposals.noteId,note.id),eq(proposals.status,'pending'))).all()
    for (const p of pending) {
      const receipt = (JSON.parse(p.ops) as {vocabulary?:Receipt}).vocabulary
      if (receipt?.word !== word) continue
      if (receipt.input.sentence !== input.sentence) throw new Error(readingError('pending'))
      return {noteId:note.id,proposalId:p.id,word,rowId:receipt.rowId,created:receipt.created}
    }
    const document = stateToJSON(loadDoc(note.id)), rows = document.content?.filter((node)=>node.type==='cornellRow') ?? []
    const same = rows.find((node)=>text(node.content?.[0]?.content?.[0]).trim().toLowerCase() === word)
    const rowId = same?.attrs?.id ? String(same.attrs.id) : null
    if (same && text(same.content?.[1]).includes(input.sentence)) {
      if(input.concept)recordConcept(word,'asked',{conversationId:`vocabulary:row:${rowId}`,note:input.gloss})
      return {noteId:note.id,proposalId:null,word,rowId,created:false}
    }
    const body = [paragraph(input.gloss),paragraph(input.sentence),...sourceParagraph(access.url ?? `jiwei://source/${input.target.kind==='source'?input.target.id:''}`)]
    const escaped = input.word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
    const cloze = input.sentence.replace(new RegExp(`\\b${escaped}\\b`,'gi'),'____')
    const op: ProposalOp = rowId ? {op:'insert_after',blockId:rowId,nodes:body} : {op:'insert_row',afterRowId:null,cue:[paragraph(word),paragraph(cloze)],body}
    const proposal = createProposal({noteId:note.id,title:`生词：${word}`,ops:[op],auto:false,skill:'vocabulary-landing',sources:[{type:'source',id:input.target.id}]})
    const saved = db.select().from(proposals).where(eq(proposals.id,proposal.id)).get()!
    const receipt: Receipt = {input,url:access.url,word,rowId,created:!same}
    db.update(proposals).set({ops:JSON.stringify({...JSON.parse(saved.ops),vocabulary:receipt})}).where(eq(proposals.id,proposal.id)).run()
    return {noteId:note.id,proposalId:proposal.id,word,rowId,created:!same}
  })
}
export function complete(proposalId: string, update: Uint8Array): VocabularyLanding {
  const db = getDb(), saved = db.select().from(proposals).where(eq(proposals.id,proposalId)).get()
  if (!saved) throw new Error(readingError('unapplied'))
  const payload = JSON.parse(saved.ops) as {ops:ProposalOp[];vocabulary?:Receipt}, receipt = payload.vocabulary
  if (!receipt) throw new Error(readingError('unapplied'))
  const landing = (): VocabularyLanding => ({noteId:saved.noteId,proposalId,word:receipt.word,rowId:receipt.rowId,created:receipt.created})
  const finishConcept=():void=>{
    if(!receipt.input.concept||receipt.conceptRecorded)return
    recordConcept(receipt.word,'asked',{conversationId:`vocabulary:row:${receipt.rowId}`,note:receipt.input.gloss})
    receipt.conceptRecorded=true
    db.update(proposals).set({ops:JSON.stringify({...payload,vocabulary:receipt})}).where(eq(proposals.id,proposalId)).run()
  }
  const access = readingAccess(receipt.input.target)
  if (access.url !== receipt.url) throw new Error(readingError('changed'))
  access.guard()
  const note = db.select().from(notes).where(eq(notes.id,saved.noteId)).get()
  if (!note || note.deletedAt || note.aiExcluded) throw new Error(readingError('privacy'))
  if (receipt.completed) {finishConcept();return landing()}
  const document = new Y.Doc()
  let json: ReturnType<typeof stateToJSON>
  try { Y.applyUpdate(document,loadDoc(saved.noteId)); Y.applyUpdate(document,update); json = stateToJSON(Y.encodeStateAsUpdate(document)) } finally { document.destroy() }
  const found = (json.content ?? []).find((node)=>node.type==='cornellRow' && (receipt.rowId ? node.attrs?.id===receipt.rowId : text(node.content?.[0]?.content?.[0]).trim().toLowerCase()===receipt.word))
  const marked = (node: DocNode): boolean => {
    try { if ((JSON.parse(String(node.attrs?.origin)) as {proposalId?:string}).proposalId===proposalId) return true } catch { /* 原有段落无来源标记 */ }
    return node.content?.some(marked) ?? false
  }
  if (!found || !marked(found) || !text(found.content?.[1]).includes(receipt.input.sentence) || !text(found.content?.[1]).includes(receipt.input.gloss)) throw new Error(readingError('unapplied'))
  receipt.rowId = String(found.attrs?.id)
  access.guard()
  db.transaction(() => {
    pushUpdate(saved.noteId,update)
    payload.ops.forEach((_,i)=>resolveOp(proposalId,i,'accepted',[receipt.rowId!]))
    receipt.completed = true
    db.update(proposals).set({ops:JSON.stringify({...payload,vocabulary:receipt})}).where(eq(proposals.id,proposalId)).run()
  })
  // 个人库与知识库不共享事务，稳定 evidence 与完成后的恢复分支防崩溃丢失/重复计数。
  finishConcept()
  emit('docs:updated',{noteId:saved.noteId,update})
  emit('notes:changed',{ids:[saved.noteId]})
  return landing()
}

import { READING_MAX_GLOSSES, type VocabularySignal } from '@shared/reading'
export type WordRanks = Readonly<Record<string, number>>
const IRREGULAR: Record<string, string> = {
  am:'be',is:'be',are:'be',was:'be',were:'be',been:'be',being:'be',has:'have',had:'have',does:'do',did:'do',done:'do',
  went:'go',gone:'go',came:'come',ran:'run',saw:'see',seen:'see',said:'say',made:'make',took:'take',taken:'take',
  got:'get',gotten:'get',gave:'give',given:'give',knew:'know',known:'know',thought:'think',bought:'buy',brought:'bring',
  wrote:'write',written:'write',read:'read',ate:'eat',eaten:'eat',spoke:'speak',spoken:'speak',found:'find',felt:'feel',
  left:'leave',kept:'keep',held:'hold',told:'tell',understood:'understand',learnt:'learn',better:'good',best:'good',worse:'bad',worst:'bad',
  children:'child',men:'man',women:'woman',people:'person',teeth:'tooth',feet:'foot',mice:'mouse',indices:'index',analyses:'analysis'
}
export function englishLemma(input: string, ranks: WordRanks = {}): string {
  const word = input.toLowerCase().replace(/[’']/g,"'").replace(/'s$/, '')
  if (IRREGULAR[word]) return IRREGULAR[word]
  const candidates: string[] = []
  if (word.endsWith('ies') && word.length > 4) candidates.push(word.slice(0,-3)+'y')
  if (word.endsWith('ied') && word.length > 4) candidates.push(word.slice(0,-3)+'y')
  if (word.endsWith('ing') && word.length > 5) { const root = word.slice(0,-3); candidates.push(root,root+'e',root.replace(/([b-df-hj-np-tv-z])\1$/,'$1')) }
  if (word.endsWith('ed') && word.length > 4) { const root = word.slice(0,-2); candidates.push(root,root+'e',root.replace(/([b-df-hj-np-tv-z])\1$/,'$1')) }
  if (word.endsWith('est') && word.length > 5) candidates.push(word.slice(0,-3),word.slice(0,-3)+'e',word.slice(0,-3).replace(/i$/,'y'))
  if (word.endsWith('er') && word.length > 4) candidates.push(word.slice(0,-2),word.slice(0,-2)+'e',word.slice(0,-2).replace(/i$/,'y'))
  if (/(?:ches|shes|xes|zes|ses)$/.test(word)) candidates.push(word.slice(0,-2))
  if (word.endsWith('s') && !/(?:ss|us|is)$/.test(word) && word.length > 3) candidates.push(word.slice(0,-1))
  // 原词本身也参与比较：after 不能被当成 aft + er、species 不能被当成 specie。
  const known = [word, ...candidates].filter((candidate) => ranks[candidate]).sort((a,b) => ranks[a]-ranks[b])
  return known[0] ?? (ranks[word] ? word : candidates.find((candidate) => candidate !== word) ?? word)
}
export interface AnnotationCandidate { word: string; lemma: string; rank: number; start: number; end: number }
export function annotationWords(text: string, threshold: number, known: ReadonlySet<string>, ranks: WordRanks, limit = READING_MAX_GLOSSES): AnnotationCandidate[] {
  const ignoredPattern=/https?:\/\/\S+|www\.\S+|`[^`]*`|\$[^$]*\$|\b[A-Za-z_][A-Za-z0-9_]*:\d[^\s]*/g
  const ignored: [number,number][] = [...text.matchAll(ignoredPattern)].map((match)=>[match.index,match.index+match[0].length])
  const capitalsOnly=!/[a-z]/.test(text.replace(ignoredPattern,' '))
  const selected: AnnotationCandidate[] = [], seen = new Set<string>()
  for (const match of text.matchAll(/\b[A-Za-z]+(?:['’][A-Za-z]+)?\b/g)) {
    const start = match.index, word = match[0]
    if (ignored.some(([from,to]) => start >= from && start < to)) continue
    const before = text.slice(0,start).trimEnd()
    const lemma = englishLemma(word,ranks), rank = ranks[lemma] ?? ranks[word.toLowerCase()] ?? 50001
    // Initialisms and mixed-case identifiers remain names at sentence boundaries.
    // Dictionary words in a fully capitalized heading are still ordinary vocabulary.
    const capitalDictionaryWord=capitalsOnly && /^[A-Z]+$/.test(word) && Object.hasOwn(ranks,lemma)
    if (!capitalDictionaryWord && (/^[A-Z]{2,}$/.test(word) || /[a-z][A-Z]/.test(word))) continue
    if (!capitalDictionaryWord && /^[A-Z]/.test(word) && before && !/[.!?]\s*$/.test(before)) continue
    // 缩写（can't / don't / we're）不在词频表里，会被当成最生僻的词。
    if (/['’](?:t|s|re|ve|ll|d|m)$/i.test(word)) continue
    if (word.length < 3 || rank <= threshold || known.has(lemma) || seen.has(lemma)) continue
    seen.add(lemma); selected.push({ word,lemma,rank,start,end:start+word.length })
  }
  // 只留最生僻的几个，再按原文顺序排列。
  return selected.sort((a,b)=>b.rank-a.rank).slice(0,limit).sort((a,b)=>a.start-b.start)
}
export function adjustVocabulary(threshold: number, signals: VocabularySignal[]): { threshold: number; consumed: number; recognized: number; queried: number } {
  if (signals.length < 50) return {threshold,consumed:0,recognized:0,queried:0}
  const batch = signals.slice(0,50), recognized = batch.filter((signal)=>signal.kind==='recognized').length, queried = 50-recognized
  const factor = Math.max(-0.1,Math.min(0.1,(recognized-queried)/50*0.1))
  return { threshold:Math.max(1000,Math.min(50000,Math.round(threshold*(1+factor)))),consumed:50,recognized,queried }
}

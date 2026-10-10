import { describe, expect, it } from 'vitest'
import { englishLemma, annotationWords, adjustVocabulary } from './vocabulary'
const ranks = { learn:300, study:1000, run:800, good:500, create:900, terminology:9000, epistemology:20000, algorithm:8500, obscure:10000, quantify:12000, nuance:13000, paradigm:14000, heuristic:16000 }
describe('personal vocabulary rules', () => {
  it('lemmatizes plural, ed, ing, comparison and irregular verbs', () => {
    expect(englishLemma('studies',ranks)).toBe('study')
    expect(englishLemma('running',ranks)).toBe('run')
    expect(englishLemma('created',ranks)).toBe('create')
    expect(englishLemma('better',ranks)).toBe('good')
    expect(englishLemma('learnt',ranks)).toBe('learn')
    expect(englishLemma('after',{after:150,aft:30000})).toBe('after')
  })
  it('excludes known words, sentence-internal capitals and URLs, caps at six', () => {
    const words = annotationWords('Epistemology studies terminology at Cambridge using obscure algorithms, nuance, quantify, paradigm, heuristic. https://epistemology.example/code',6000,new Set(['terminology']),ranks)
    expect(words.map((w)=>w.word)).toContain('Epistemology')
    expect(words.map((w)=>w.lemma)).not.toContain('terminology')
    expect(words.map((w)=>w.word)).not.toContain('Cambridge')
    expect(words.length).toBeLessThanOrEqual(6)
    expect(words.filter((w)=>w.lemma==='epistemology').length).toBe(1)
  })
  it('never annotates contractions', () => {
    expect(annotationWords("You can't and don't, but we're heuristic.",6000,new Set(),{...ranks,you:2,and:3,but:20}).map((w)=>w.word)).toEqual(['heuristic'])
  })
  it('keeps only the rarest words, in reading order', () => {
    const words = annotationWords('Epistemology studies obscure algorithms with nuance, quantify the paradigm by heuristic means.',6000,new Set(),{...ranks,with:20,the:1,by:30,mean:400},3)
    expect(words.map((w)=>w.lemma)).toEqual(['epistemology','paradigm','heuristic'])
  })
  it('excludes acronym and brand identifiers even at sentence boundaries', () => {
    const text='PMID identifies a citation. IEEE publishes research. OpenAI offers tools. NASA studies space. Epistemology investigates knowledge.'
    const words=annotationWords(text,6000,new Set(),{...ranks,nasa:7500,identify:100,citation:100,publish:100,research:100,offer:100,tool:100,space:100,investigate:100,knowledge:100})
    expect(words.map((word)=>word.word)).toContain('Epistemology')
    for(const identifier of ['PMID','IEEE','OpenAI','NASA'])expect(words.map((word)=>word.word)).not.toContain(identifier)
  })
  it('excludes numeric citation identifiers while preserving contextual prose', () => {
    const text='A heuristic approach. doi:10.1109/TERM.2023.3251721. Bibcode:2023ITKDE..3510085S. key:42/value. obscure terminology.'
    const words=annotationWords(text,6000,new Set(),{...ranks,approach:100,doi:35289,key:10000,value:12000})
    expect(words.map((word)=>word.word)).toEqual(['heuristic','obscure','terminology'])
  })
  it('still annotates dictionary words in all-capital headings', () => {
    const words=annotationWords('HEURISTIC PARADIGM',6000,new Set(),ranks)
    expect(words.map((word)=>word.lemma)).toEqual(['heuristic','paradigm'])
  })
  it('does not adjust before 50 signals; adjusts at most ten percent per batch', () => {
    const positive = Array.from({length:50},(_,i)=>({kind:'recognized' as const,word:`word${i}`,rank:15000}))
    expect(adjustVocabulary(6000,positive.slice(0,49)).threshold).toBe(6000)
    expect(adjustVocabulary(6000,positive).threshold).toBe(6600)
    const negative = positive.map((s)=>({...s,kind:'queried' as const,rank:2000}))
    expect(adjustVocabulary(6000,negative).threshold).toBe(5400)
    const mixed = [...positive.slice(0,25),...negative.slice(0,25)]
    expect(adjustVocabulary(6000,mixed).threshold).toBe(6000)
    expect(adjustVocabulary(50000,positive).threshold).toBe(50000)
  })
})

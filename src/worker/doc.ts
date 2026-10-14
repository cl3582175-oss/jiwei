import WordExtractor from 'word-extractor'
import { headingLevel, type DocBlock } from '../main/lib/docBlocks'
import { chunkBlocks, type ChunkOut } from '../main/lib/chunker'

export function docBlocks(text: string): DocBlock[] {
  const blocks: DocBlock[] = []
  let lines: string[] = []
  let table: string[][] = []
  const flushParagraph = (): void => {
    if (lines.length) blocks.push({ type: 'paragraph', text: lines.join('\n') })
    lines = []
  }
  const flushTable = (): void => {
    if (table.length) blocks.push({ type: 'table', header: table[0], rows: table.slice(1) })
    table = []
  }
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (raw.includes('\t') && line) {
      flushParagraph()
      table.push(raw.split('\t').map((cell) => cell.trim()))
    } else {
      flushTable()
      const level = headingLevel(line)
      if (!line || level) {
        flushParagraph()
        if (level) blocks.push({ type: 'heading', level, text: line })
      } else lines.push(line)
    }
  }
  flushParagraph()
  flushTable()
  return blocks
}

export async function parseDoc(path: string): Promise<ChunkOut[]> {
  let text: string
  try {
    text = (await new WordExtractor().extract(path)).getBody()
  } catch {
    throw new Error('这个 .doc 文件已加密或已损坏，无法读取')
  }
  const blocks = docBlocks(text)
  return chunkBlocks(blocks, { locatorOf: (b) => ({ type: 'FragmentSelector', value: `block=${blocks.indexOf(b)}` }) })
}

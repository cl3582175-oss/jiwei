import { convertToHtml } from 'mammoth'
import { chunkBlocks, type ChunkOut } from '../main/lib/chunker'
import { htmlBlocks } from './htmlBlocks'

export async function parseDocx(path: string): Promise<ChunkOut[]> {
  const { value } = await convertToHtml({ path })
  const blocks = htmlBlocks(value)
  return chunkBlocks(blocks, { locatorOf: (b) => ({ type: 'FragmentSelector', value: `block=${blocks.indexOf(b)}` }) })
}

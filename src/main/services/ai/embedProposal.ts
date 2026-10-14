import type { ProposalInput } from '@shared/schemas'
import { createProposal } from '../proposals'
import { markdownToNodes } from '../../lib/markdown'

/** 工具与用户主动存入共用富内容提案，保留撤销、来源与正常应用路径。 */
export function visual(
  noteId: string,
  title: string,
  kind: string,
  data: unknown,
  cue?: string,
  afterBlockId?: string,
  options?: Pick<ProposalInput, 'model' | 'skill' | 'sources' | 'auto'>
) {
  const nodes = [{ type: 'embed', attrs: { id: 'v', kind } }]
  return createProposal({
    noteId,
    title,
    ...options,
    ops: afterBlockId
      ? [{ op: 'insert_after', blockId: afterBlockId, nodes }]
      : [{ op: 'insert_row', afterRowId: null, cue: cue?.trim() ? markdownToNodes(cue) : [], body: nodes }],
    embeds: { v: { kind, data } }
  })
}

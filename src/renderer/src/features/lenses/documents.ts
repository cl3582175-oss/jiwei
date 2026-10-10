import { api } from '@/lib/utils'
import type { Landing } from '@shared/lens'
import { applyReviewedDocument } from '../inbox/documents'

export async function applyLensLanding(landing: Landing, undo = false): Promise<void> {
  const proposalId = undo ? landing.undoProposalId : landing.proposalId
  const complete = (update: Uint8Array) => (undo ? api.lenses.undoComplete(landing.id, update) : api.lenses.complete(landing.id, update))
  if (landing.noteId && proposalId) await applyReviewedDocument(landing.noteId, proposalId, complete)
  else await complete(new Uint8Array())
}

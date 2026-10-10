import { api } from '@/lib/utils'
import { applyReviewedDocument } from '../inbox/documents'

export async function landMistake(id: string): Promise<void> {
  for (let step = 0; step < 2; step++) {
    const landing = await api.mistakes.prepare(id)
    if (!landing.proposalId) return
    await applyReviewedDocument(landing.noteId, landing.proposalId, (update) => api.mistakes.complete(id, landing.proposalId!, update))
    if (!landing.moving) return
  }
}
export async function removeMistake(id: string): Promise<void> {
  const landing = await api.mistakes.remove(id)
  if (landing?.proposalId) await applyReviewedDocument(landing.noteId, landing.proposalId, (update) => api.mistakes.removeComplete(id, landing.proposalId!, update))
}

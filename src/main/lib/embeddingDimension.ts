import { EMBEDDING_DIM } from '@shared/ai'
export class EmbeddingDimensionError extends Error {
  constructor(readonly dim: number) {
    super(`Embedding model returned ${dim} dimensions; expected ${EMBEDDING_DIM}`)
    this.name = 'EmbeddingDimensionError'
  }
}

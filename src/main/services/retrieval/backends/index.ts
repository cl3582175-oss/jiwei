import type { BackendId } from '@shared/retrieval'
import type { SearchBackend } from './common'
import { bocha } from './bocha'
import { zhipu } from './zhipu'
import { tavily } from './tavily'
import { brave } from './brave'
import { exa } from './exa'
import { serper } from './serper'
import { searxng } from './searxng'
import { openalex } from './openalex'
import { semanticscholar } from './semanticscholar'
import { arxiv } from './arxiv'
export const BACKENDS: Record<BackendId, SearchBackend> = {
  bocha,
  zhipu,
  tavily,
  brave,
  exa,
  serper,
  searxng,
  openalex,
  semanticscholar,
  arxiv
}
export { BackendError } from './common'
export type { BackendQuery, SearchBackend } from './common'

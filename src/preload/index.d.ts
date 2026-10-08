import type { JiweiAPI, JiweiEvents } from '../shared/types'

declare global {
  interface Window {
    jiwei: JiweiAPI
    jiweiEvents: {
      on<K extends keyof JiweiEvents>(event: K, cb: (payload: JiweiEvents[K]) => void): () => void
    }
    platform: {
      os: string
      pathForFile(file: File): string
    }
  }
}

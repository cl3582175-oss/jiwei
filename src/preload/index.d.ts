import type { JiweiAPI } from '../shared/types'

declare global {
  interface Window {
    jiwei: JiweiAPI
    platform: {
      os: string
      pathForFile(file: File): string
    }
  }
}

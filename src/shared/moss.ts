export interface MossStatus {
  state: 'missing' | 'downloading' | 'ready' | 'error' | 'unsupported'
  progress: number
  mirror: string | null
  speed: number | null
  message: string | null
  size: number
  running: boolean
  supported: boolean
}

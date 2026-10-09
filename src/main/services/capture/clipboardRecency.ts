// 只保存散列与真正观测到变化的时间，不缓存剪贴板正文。
export class ClipboardRecency {
  private fingerprint: string | null = null
  private changedAt: number | null = null
  observe(fingerprint: string, now = Date.now()): void {
    if (this.fingerprint !== null && this.fingerprint !== fingerprint) this.changedAt = now
    this.fingerprint = fingerprint
  }
  fresh(now = Date.now()): boolean {
    return this.changedAt !== null && now - this.changedAt <= 30000
  }
}

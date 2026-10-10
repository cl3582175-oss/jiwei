import { tr } from '../lib/messages'
import type { SafetyProgress } from '@shared/backup'

export class SafetyOperation {
  private controller: AbortController | null = null
  private finished: Promise<void> = Promise.resolve()
  private finish: (() => void) | null = null
  async stop(): Promise<void> {
    this.cancel()
    await this.finished
  }
  value: SafetyProgress = { kind: '', state: 'idle', processed: 0, total: 0, startedAt: 0, remainingSeconds: null, message: '' }
  cancel(): void {
    this.controller?.abort(new Error(tr('操作已取消', 'Operation canceled')))
  }
  get running(): boolean {
    return this.controller !== null
  }
  progress(bytes: number, total = this.value.total): void {
    const processed = Math.min(bytes, total),
      elapsed = (Date.now() - this.value.startedAt) / 1000
    this.value = {
      ...this.value,
      processed,
      total,
      remainingSeconds: processed > 0 && total > processed ? Math.ceil((elapsed * (total - processed)) / processed) : null
    }
  }
  async run<T>(kind: string, fn: (signal: AbortSignal) => Promise<T>, success = tr('已完成', 'Done')): Promise<T> {
    if (this.controller) throw new Error(tr('已有操作正在进行，请稍候', 'Another operation is in progress; please wait'))
    const controller = new AbortController()
    this.controller = controller
    this.finished = new Promise((resolve) => {
      this.finish = resolve
    })
    this.value = { kind, state: 'running', processed: 0, total: 0, startedAt: Date.now(), remainingSeconds: null, message: tr('正在准备…', 'Preparing…') }
    try {
      const result = await fn(controller.signal)
      this.value = { ...this.value, state: 'done', processed: this.value.total, remainingSeconds: 0, message: success }
      return result
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const message = controller.signal.aborted
        ? tr('操作已取消，可以重新开始', 'Canceled. You can start again.')
        : code === 'ENOSPC'
          ? tr('磁盘空间不足，请清理空间后重试', 'Not enough disk space. Free up space and try again.')
          : code === 'EACCES' || code === 'EPERM'
            ? tr('没有读写这个位置的权限，请选择其他文件夹', 'No permission to use this location. Choose another folder.')
            : error instanceof Error && !code
              ? error.message
              : tr('无法读写文件，请检查磁盘和文件夹后重试', 'Could not read or write files. Check the disk and folder, then try again.')
      this.value = { ...this.value, state: controller.signal.aborted ? 'canceled' : 'failed', message }
      throw new Error(message, { cause: error })
    } finally {
      this.controller = null
      this.finish?.()
      this.finish = null
    }
  }
}

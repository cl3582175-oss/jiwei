import type { ReactNode } from 'react'

interface DialogOptions {
  title: ReactNode
  description?: ReactNode
  confirmText?: string
  danger?: boolean
  /** An entity/action identity supplied by its owner, never inferred from display text. */
  operationKey?: string
  signal?: AbortSignal
}

export type ConfirmOptions = DialogOptions

export interface PromptOptions extends DialogOptions {
  placeholder?: string
  defaultValue?: string
  /** The business controller supplies only its real write; failure keeps the draft open for retry. */
  submit?: (value: string) => void | Promise<void>
}

interface RequestState {
  submitting?: boolean
  error?: unknown
}

export type DialogRequest =
  | (ConfirmOptions & RequestState & { readonly id: number; readonly kind: 'confirm' })
  | (PromptOptions & RequestState & { readonly id: number; readonly kind: 'prompt' })

type Entry = {
  request: DialogRequest
  resolve: (result: boolean | string | null) => void
  removeAbortListener: () => void
  detached?: boolean
}

/** The Promise protocol is independent of React so every pending resolver has one owner. */
export function createConfirmQueue() {
  let nextId = 0
  const pending: Entry[] = []
  const operationKeys = new Set<string>()
  const listeners = new Set<() => void>()
  const hosts = new Set<symbol>()

  const getSnapshot = (): DialogRequest | null => pending.find((entry) => !entry.detached)?.request ?? null
  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  const release = (entry: Entry): void => {
    entry.removeAbortListener()
    if (entry.request.operationKey !== undefined) operationKeys.delete(entry.request.operationKey)
  }

  const settle = (id: number, result: boolean | string | null): boolean => {
    const previous = getSnapshot()
    const index = pending.findIndex((entry) => entry.request.id === id)
    if (index === -1) return false
    const [entry] = pending.splice(index, 1)
    release(entry)
    entry.resolve(result)
    if (getSnapshot() !== previous) notify()
    return true
  }

  const cancel = (id: number): boolean => {
    const entry = pending.find((item) => item.request.id === id)
    if (entry?.request.submitting) {
      const previous = getSnapshot()
      // A started write cannot be revoked by UI cleanup. Hide its abandoned
      // dialog, retain its resolver/key, and wait for the actual write outcome.
      entry.detached = true
      entry.removeAbortListener()
      if (getSnapshot() !== previous) notify()
      return true
    }
    return entry ? settle(id, entry.request.kind === 'confirm' ? false : null) : false
  }

  const cancelAll = (): void => {
    const previous = getSnapshot()
    for (const entry of [...pending]) {
      if (entry.request.submitting) {
        entry.detached = true
        entry.removeAbortListener()
        continue
      }
      pending.splice(pending.indexOf(entry), 1)
      release(entry)
      entry.resolve(entry.request.kind === 'confirm' ? false : null)
    }
    if (getSnapshot() !== previous) notify()
  }

  function enqueue(kind: 'confirm', options: ConfirmOptions): Promise<boolean>
  function enqueue(kind: 'prompt', options: PromptOptions): Promise<string | null>
  function enqueue(kind: 'confirm' | 'prompt', options: PromptOptions): Promise<boolean | string | null> {
    const signal = options.signal
    const cancelled = kind === 'confirm' ? false : null
    if (options.signal?.aborted || (options.operationKey !== undefined && operationKeys.has(options.operationKey))) {
      return Promise.resolve(cancelled)
    }

    return new Promise((resolve) => {
      const previous = getSnapshot()
      const request = { ...options, id: ++nextId, kind } as DialogRequest
      const onAbort = (): void => {
        cancel(request.id)
      }
      let listening = !!signal
      const entry: Entry = {
        request,
        resolve,
        removeAbortListener: () => {
          if (!listening) return
          listening = false
          signal?.removeEventListener('abort', onAbort)
        }
      }
      if (options.operationKey !== undefined) operationKeys.add(options.operationKey)
      pending.push(entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (getSnapshot() !== previous) notify()
    })
  }

  return {
    confirm: (options: ConfirmOptions): Promise<boolean> => enqueue('confirm', options),
    prompt: (options: PromptOptions): Promise<string | null> => enqueue('prompt', options),
    getSnapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    accept(id: number, value?: string): boolean {
      const request = getSnapshot()
      // A stale click cannot approve a newly displayed or still waiting request.
      if (!request || request.id !== id || request.signal?.aborted || request.submitting) return false
      if (request.kind === 'confirm') return settle(id, true)
      const trimmed = value?.trim()
      if (!trimmed) return false
      if (!request.submit) return settle(id, trimmed)
      const entry = pending.find((item) => item.request.id === id)!
      entry.request = { ...request, submitting: true, error: undefined }
      notify()
      const failed = (error: unknown): void => {
        if (entry.detached || request.signal?.aborted) {
          settle(id, null)
          return
        }
        entry.request = { ...request, submitting: false, error }
        notify()
      }
      if (entry.detached || request.signal?.aborted) return settle(id, null)
      try {
        void Promise.resolve(request.submit(trimmed)).then(() => {
          // null signals stale UI ownership only. A write that already began
          // still finishes before this Promise and its action lock are released.
          settle(id, entry.detached || request.signal?.aborted ? null : trimmed)
        }, failed)
      } catch (error) {
        failed(error)
      }
      return true
    },
    cancel,
    attachHost(): () => void {
      const host = Symbol('dialog-host')
      hosts.add(host)
      return () => {
        if (!hosts.delete(host)) return
        // React StrictMode replays effects synchronously. Only a genuinely removed
        // final host cancels requests; the replacement effect retains its queue.
        queueMicrotask(() => {
          if (hosts.size === 0) cancelAll()
        })
      }
    }
  }
}

/** A scope's signal survives StrictMode replay and aborts after its final cleanup. */
export function createDialogScope() {
  const controller = new AbortController()
  const leases = new Set<symbol>()
  return {
    signal: controller.signal,
    attach(): () => void {
      const lease = Symbol('dialog-owner')
      leases.add(lease)
      return () => {
        if (!leases.delete(lease)) return
        queueMicrotask(() => {
          if (leases.size === 0) controller.abort()
        })
      }
    }
  }
}

const actionLocks = new Set<string>()

/**
 * Acquires synchronously, before the action's first await, and holds through its
 * entire mutation. false means a duplicate/aborted invocation was not entered;
 * true means the callback finished (it can have chosen to cancel confirmation).
 * Errors propagate to the caller and always release the lock.
 */
export async function withActionLock(
  operationKey: string | readonly string[],
  action: () => void | Promise<void>,
  options: { signal?: AbortSignal } = {}
): Promise<boolean> {
  const keys = typeof operationKey === 'string' ? [operationKey] : [...new Set(operationKey)]
  if (options.signal?.aborted || keys.some((key) => actionLocks.has(key))) return false
  for (const key of keys) actionLocks.add(key)
  try {
    await action()
    return true
  } finally {
    for (const key of keys) actionLocks.delete(key)
  }
}

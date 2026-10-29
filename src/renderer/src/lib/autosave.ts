/** Serialize writes so a slow earlier save cannot overwrite the newest draft. */
export function createAutosave<T>(
  initial: T,
  persist: (value: T) => Promise<unknown>,
  options: {
    delay?: number | false
    onError?: (error: unknown) => void
    onState?: (state: 'saving' | 'saved') => void
  } = {}
) {
  let draft = initial,
    saved = initial
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()
  let epoch = 0
  let draftVersion = 0
  const flush = (): Promise<void> => {
    clearTimeout(timer)
    const value = draft
    const requestedEpoch = epoch
    const next = queue
      .catch(() => {})
      .then(async () => {
        if (requestedEpoch !== epoch) return
        if (value === saved) return
        options.onState?.('saving')
        try {
          await persist(value)
          saved = value
          if (draft === saved) options.onState?.('saved')
        } catch (error) {
          options.onError?.(error)
          throw error
        }
      })
    queue = next
    return next
  }
  return {
    get dirty() {
      return draft !== saved
    },
    accept(value: T) {
      if (draft === saved) draft = saved = value
    },
    change(value: T) {
      draftVersion++
      draft = value
      clearTimeout(timer)
      if (draft !== saved) {
        options.onState?.('saving')
        if (options.delay !== false)
          timer = setTimeout(() => {
            void flush().catch(() => {})
          }, options.delay ?? 600)
      }
    },
    async discard(): Promise<T> {
      clearTimeout(timer)
      epoch++
      const version = draftVersion
      // Persist already in progress must finish. Its real outcome becomes the
      // saved baseline; queued writes from the abandoned epoch are skipped.
      await queue.catch(() => {})
      if (draftVersion === version) {
        draft = saved
        options.onState?.('saved')
      }
      return draft
    },
    flush
  }
}

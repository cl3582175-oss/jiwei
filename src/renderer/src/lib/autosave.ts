/** Serialize writes so a slow earlier save cannot overwrite the newest draft. */
export function createAutosave<T>(
  initial: T,
  persist: (value: T) => Promise<unknown>,
  options: {
    delay?: number
    onError?: (error: unknown) => void
    onState?: (state: 'saving' | 'saved') => void
  } = {}
) {
  let draft = initial,
    saved = initial
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue = Promise.resolve()
  const flush = (): Promise<void> => {
    clearTimeout(timer)
    const value = draft
    const next = queue
      .catch(() => {})
      .then(async () => {
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
      draft = value
      clearTimeout(timer)
      if (draft !== saved) {
        options.onState?.('saving')
        timer = setTimeout(() => {
          void flush().catch(() => {})
        }, options.delay ?? 600)
      }
    },
    flush
  }
}

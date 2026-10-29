export interface SettingsField {
  dirty: () => boolean
  validate?: () => string | null | undefined
  flush: () => Promise<unknown>
  discard?: () => void | Promise<void>
}

export function createSettingsTransition() {
  const fields = new Map<string, SettingsField>()
  const listeners = new Set<() => void>()
  let state = { pending: false, error: null as unknown }
  let intent: { key: string; commit: () => void } | null = null
  let running: Promise<boolean> | null = null
  const publish = (pending: boolean, error: unknown = null): void => {
    state = { pending, error }
    listeners.forEach((listener) => listener())
  }
  const run = (discard = false): Promise<boolean> => {
    publish(true)
    running = Promise.resolve().then(async () => {
      try {
        const active = [...fields.values()]
        if (discard) {
          await Promise.all(active.filter((field) => field.dirty()).map((field) => field.discard?.()))
        } else {
          for (const field of active) {
            const error = field.dirty() && field.validate?.()
            if (error) throw new Error(error)
          }
          // All saves settle before editing is unlocked, even if one fails.
          const results = await Promise.allSettled(active.map((field) => Promise.resolve().then(() => field.flush())))
          const failed = results.find((result) => result.status === 'rejected')
          if (failed?.status === 'rejected') throw failed.reason
        }
        const destination = intent
        intent = null
        destination?.commit()
        publish(false)
        return true
      } catch (error) {
        publish(false, error)
        return false
      } finally {
        running = null
      }
    })
    return running
  }
  return {
    register(key: string, field: SettingsField) {
      fields.set(key, field)
      return () => {
        if (fields.get(key) === field) fields.delete(key)
      }
    },
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    request(key: string, commit: () => void): Promise<boolean> {
      // Keep one flush in flight and honor the latest distinct destination.
      if (!running || intent?.key !== key) intent = { key, commit }
      return running ?? run()
    },
    retry: (): Promise<boolean> => running ?? (intent ? run() : Promise.resolve(false)),
    continueEditing: (): void => {
      if (running) return
      intent = null
      publish(false)
    },
    discard: (): Promise<boolean> => (!running && intent && state.error ? run(true) : Promise.resolve(false))
  }
}

export const settingsTransition = createSettingsTransition()

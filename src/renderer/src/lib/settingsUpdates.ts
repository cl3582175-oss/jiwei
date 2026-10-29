import type { SettingsPatch } from '@shared/schemas'
import type { Settings } from '@shared/types'

/** Compose replacement-shaped payloads only when their serialized turn begins. */
export type SettingsUpdate = SettingsPatch | ((confirmed: Settings) => SettingsPatch)

export function applySettingsPatch(base: Settings, patch: SettingsPatch): Settings {
  const next = { ...base, ...patch } as Settings
  // Match the explicitly merged groups in main/services/settings. Arrays and
  // replacement groups retain their existing semantics; this is not deepMerge.
  if (patch.ai) next.ai = { ...base.ai, ...patch.ai, ui: { ...base.ai.ui, ...patch.ai.ui } }
  if (patch.retrieval) next.retrieval = { ...base.retrieval, ...patch.retrieval }
  if (patch.updates) next.updates = { ...base.updates!, ...patch.updates }
  if (patch.plugins) next.plugins = { ...base.plugins, ...patch.plugins }
  if (patch.discover) next.discover = { ...base.discover, ...patch.discover }
  if (patch.tasks) next.tasks = { ...base.tasks, ...patch.tasks }
  if (patch.review) next.review = { ...base.review, ...patch.review }
  if (patch.reflection) next.reflection = { ...base.reflection, ...patch.reflection }
  if (patch.sidebars) next.sidebars = { ...base.sidebars, ...patch.sidebars }
  if (patch.capture) next.capture = { ...base.capture, ...patch.capture }
  if (patch.money) next.money = { ...base.money, ...patch.money }
  return next
}

export function createSettingsUpdates(options: {
  initial?: Settings
  read: () => Promise<Settings>
  write: (patch: SettingsPatch) => Promise<Settings>
  publish: (settings: Settings) => void
}) {
  let confirmed = options.initial
  let snapshot = confirmed
  let queue = Promise.resolve()
  const pending: { update: SettingsUpdate; result?: Promise<Settings> }[] = []
  const patchFor = (update: SettingsUpdate, base: Settings): SettingsPatch => (typeof update === 'function' ? update(base) : update)
  const publish = (): Settings | undefined => {
    snapshot = confirmed && pending.reduce((value, item) => applySettingsPatch(value, patchFor(item.update, value)), confirmed)
    if (snapshot) options.publish(snapshot)
    return snapshot
  }

  // Reads use the same queue as writes. A read initiated before an edit can
  // update the confirmed baseline, but pending leaves remain on top. A later
  // broadcast is read after earlier writes have settled, never applied as an
  // out-of-order whole-table response.
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation)
    queue = result.then(
      () => {},
      () => {}
    )
    return result
  }

  return {
    get snapshot() {
      return snapshot
    },
    get dirty() {
      return pending.length > 0
    },
    update(update: SettingsUpdate): Promise<Settings> {
      const item: (typeof pending)[number] = { update: typeof update === 'function' ? update : structuredClone(update) }
      pending.push(item)
      const remove = (): void => {
        pending.splice(pending.indexOf(item), 1)
      }
      item.result = enqueue(async () => {
        try {
          if (!confirmed) confirmed = await options.read()
          // A preview may include an earlier optimistic patch that later fails.
          // The persisted replacement is composed from confirmed data only.
          const saved = await options.write(patchFor(item.update, confirmed))
          confirmed = saved
          remove()
          publish()
          return saved
        } catch (error) {
          remove()
          publish()
          try {
            confirmed = await options.read()
          } catch {
            /* Keep the last confirmed baseline if recovery also fails. */
          }
          publish()
          throw error
        }
      })
      publish()
      return item.result
    },
    refresh(): Promise<Settings> {
      return enqueue(async () => {
        confirmed = await options.read()
        return publish()!
      })
    },
    async flush(): Promise<void> {
      const settled = await Promise.allSettled(pending.map((item) => item.result!))
      const failed = settled.find((item) => item.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
  }
}

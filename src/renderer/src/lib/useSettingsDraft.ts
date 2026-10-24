import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createAutosave } from './autosave'
import { useSettingsField } from './useSettingsField'

/** A field owns its draft and rules; the settings boundary only awaits it. */
export function useSettingsDraft<T>({
  key,
  value,
  persist,
  validate,
  onError,
  onDiscard,
  delay = false
}: {
  key: string
  value: T
  persist: (value: T) => Promise<unknown>
  validate?: (value: T) => string | null | undefined
  onError?: (error: unknown) => void
  onDiscard?: () => void
  delay?: number | false
}) {
  const [draft, setDraft] = useState(value)
  const draftValue = useRef(value)
  const current = useRef({ persist, validate, onError, onDiscard })
  useLayoutEffect(() => {
    current.current = { persist, validate, onError, onDiscard }
  })
  const [save] = useState(() =>
    createAutosave(
      value,
      async (next: T) => {
        const error = current.current.validate?.(next)
        if (error) throw new Error(error)
        await current.current.persist(next)
      },
      { delay, onError: (error) => current.current.onError?.(error) }
    )
  )
  useEffect(() => {
    if (save.dirty) return
    save.accept(value)
    draftValue.current = value
    setDraft(value)
  }, [save, value])
  const discard = async (): Promise<void> => {
    const next = await save.discard()
    draftValue.current = next
    setDraft(next)
    current.current.onDiscard?.()
  }
  useSettingsField(key, {
    dirty: () => save.dirty,
    validate: () => current.current.validate?.(draftValue.current),
    flush: () => save.flush(),
    discard
  })
  return {
    draft,
    validationError: save.dirty ? validate?.(draft) : null,
    get dirty() {
      return save.dirty
    },
    change(next: T) {
      draftValue.current = next
      setDraft(next)
      save.change(next)
    },
    flush: save.flush,
    discard,
    blur() {
      void save.flush().catch(() => {})
    }
  }
}

import { useEffect, useLayoutEffect, useRef } from 'react'
import { settingsTransition, type SettingsField } from './settingsTransition'

/** Register the live field contract without making the transition own drafts. */
export function useSettingsField(key: string, field: SettingsField): void {
  const current = useRef(field)
  useLayoutEffect(() => {
    current.current = field
  })
  useEffect(
    () =>
      settingsTransition.register(key, {
        dirty: () => current.current.dirty(),
        validate: () => current.current.validate?.(),
        flush: () => current.current.flush(),
        discard: () => current.current.discard?.()
      }),
    [key]
  )
}

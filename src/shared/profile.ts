import type { ProfileKey } from './types'

/** Shared by IPC validation and the profile editor's counts and limits. */
export const PROFILE_LIMITS = {
  role: 500,
  goals: 6000,
  background: 1000,
  style: 6000,
  avoid: 1000
} as const satisfies Record<ProfileKey, number>

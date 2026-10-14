import { z } from 'zod'

export const UiSettingsSchema = z.object({
  density: z.enum(['off', 'normal', 'rich']),
  dataAccess: z.boolean(),
  inline: z.boolean(),
  localModels: z.enum(['off', 'normal'])
})
export type UiSettings = z.infer<typeof UiSettingsSchema>
export const UI_DEFAULTS: UiSettings = { density: 'normal', dataAccess: true, inline: true, localModels: 'off' }

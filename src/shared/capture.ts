import { z } from 'zod'
import type { AssetRef, RegionRecognition } from './types'
import type { InboxOrigin } from './inbox'
export const CaptureSettingsSchema = z.object({
  daily: z.boolean().optional(),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  offPeak: z.boolean().optional(),
  quickShortcut: z.string().max(100).optional(),
  screenshotShortcut: z.string().max(100).optional(),
  sourceInfo: z.boolean().optional()
})
export const CaptureActionSchema = z.object({
  id: z.uuid(),
  action: z.enum(['save', 'ask', 'insert']),
  text: z.string().max(100000),
  formulas: z.array(z.string().max(10000)).max(100).default([])
})
export interface CaptureState {
  id: string
  mode: 'text' | 'screenshot' | 'select'
  origin: InboxOrigin
  asset: AssetRef | null
  image: string | null
  recognition: RegionRecognition | null
  recognitionState: 'none' | 'pending' | 'ready' | 'unavailable'
  clipboard: boolean
  targetNoteId: string | null
  error: string | null
}
export interface CaptureDelivery {
  id: string
  action: 'ask' | 'insert'
  text: string
  formulas: string[]
  image: string | null
  asset: AssetRef | null
  noteId: string | null
  sourceId: string | null
}
export interface PhoneStatus {
  sessionId: string
  url: string
  qr: string
  expiresAt: number
  received: number
  active: boolean
}
export const captureDefaults = (mac: boolean) => ({
  daily: true,
  time: '21:00',
  offPeak: false,
  quickShortcut: mac ? 'Alt+Command+N' : 'Ctrl+Alt+N',
  screenshotShortcut: mac ? 'Alt+Command+S' : 'Ctrl+Alt+S',
  sourceInfo: false
})
export const mergeCaptureSettings = (stored: Partial<ReturnType<typeof captureDefaults>> | undefined, mac: boolean) => ({
  ...captureDefaults(mac),
  ...stored
})

import { z } from 'zod'
import type { Anchor } from './context'
import type { RegionRecognition } from './types'

export const CaptureRectSchema = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().positive().max(1), h: z.number().positive().max(1) })
  .refine((r) => r.x + r.w <= 1.001 && r.y + r.h <= 1.001)
export const BrowserCaptureEntriesSchema = z
  .array(z.object({ id: z.string().min(1).max(64), text: z.string().trim().min(1).max(12000) }))
  .min(1)
  .max(50)
export type CaptureRect = z.infer<typeof CaptureRectSchema>
export interface BrowserCaptureFrame {
  id: string
  tabId: string
  scope: string
  url: string
  image: string
}
export interface BrowserCaptureResult extends BrowserCaptureFrame {
  sourceId: string
  title: string
  capturedAt: number
  anchor: Anchor
  recognition: RegionRecognition | null
}

/** 选区使用归一化坐标；按实际像素裁切，避免 Retina 和缩放后的占位尺寸混用。 */
export function capturePixels(rect: CaptureRect, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const r = CaptureRectSchema.parse(rect)
  const x = Math.floor(r.x * width),
    y = Math.floor(r.y * height)
  return {
    x,
    y,
    width: Math.max(1, Math.min(width, Math.ceil((r.x + r.w) * width)) - x),
    height: Math.max(1, Math.min(height, Math.ceil((r.y + r.h) * height)) - y)
  }
}
export function captureIdentityValid(
  expected: { tabId: string; scope: string; url: string },
  current: { tabId: string; scope: string; url: string; sensitive: boolean; incognito: boolean } | null
): boolean {
  return (
    !!current &&
    !current.sensitive &&
    !current.incognito &&
    /^https?:\/\//i.test(current.url) &&
    expected.tabId === current.tabId &&
    expected.scope === current.scope &&
    expected.url === current.url
  )
}

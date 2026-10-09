import { useEffect } from 'react'
import { api } from '@/lib/utils'
import { askInline } from '../assist/actions'
import { freezeCapture, insertCapture, releaseCapture } from './editor'
export function useCaptureEvents(): void {
  useEffect(() => {
    const prepare = window.jiweiEvents.on('capture:prepare', ({ id }) => {
      void api.capture.context(id, freezeCapture(id))
    })
    const release = window.jiweiEvents.on('capture:release', ({ id }) => releaseCapture(id))
    const deliver = window.jiweiEvents.on('capture:deliver', (p) => {
      void (async () => {
        try {
          if (p.action === 'insert') await insertCapture(p)
          else if (p.sourceId)
            await askInline(
              'ask',
              {
                kind: 'region',
                parentType: 'source',
                parentId: p.sourceId,
                ownerId: null,
                quote: [p.text, ...p.formulas].filter(Boolean).join('\n').slice(0, 8000)
              },
              { x: 260, y: 120, w: 400, h: 180 },
              undefined,
              p.image ?? undefined
            )
          else throw new Error('capture.expired')
          await api.capture.delivered(p.id, null)
        } catch (e) {
          await api.capture.delivered(p.id, e instanceof Error ? e.message : 'capture.noNote')
        }
      })()
    })
    return () => {
      prepare()
      release()
      deliver()
    }
  }, [])
}

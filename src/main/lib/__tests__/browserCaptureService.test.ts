import * as Y from 'yjs'
import { DOC_FIELD } from '@shared/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  doc: new Uint8Array(),
  scope: 'one',
  url: 'https://example.com/article',
  private: false,
  sensitive: false,
  source: { deletedAt: null as number | null, aiExcluded: false },
  settings: {
    language: 'en',
    browser: { aiBlockedSites: [] as string[] },
    ai: { chat: { providerId: null as string | null, model: null as string | null } }
  },
  ocr: vi.fn(),
  saveTab: vi.fn(),
  saveAnswer: vi.fn(),
  structured: vi.fn(),
  end: vi.fn()
}))
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: () => ({
      getSize: () => ({ width: 800, height: 600 }),
      crop: () => ({ toDataURL: () => 'data:image/png;base64,crop' }),
      toDataURL: () => 'data:image/png;base64,frame'
    })
  }
}))
vi.mock('../../services/browser/manager', () => ({
  getTab: () => ({
    id: 'tab',
    captureScope: state.scope,
    incognito: state.private,
    view: { webContents: { getURL: () => state.url, getTitle: () => 'Title' } }
  }),
  isSensitive: () => state.sensitive,
  beginCaptureFreeze: async () => ({ getScaleFactors: () => [2], toPNG: () => Buffer.from('frame') }),
  endCaptureFreeze: state.end
}))
vi.mock('../../services/recognize', () => ({ recognizeRegionDetailed: state.ocr }))
vi.mock('../../services/browser/pages', () => ({ saveTab: state.saveTab }))
vi.mock('../../services/settings', () => ({ getSettings: () => state.settings }))
vi.mock('../../services/saveAnswer', () => ({ saveAnswer: state.saveAnswer }))
vi.mock('../../services/ai/structured', () => ({ structured: state.structured, quickModel: () => 'model' }))
vi.mock('../../services/docs', () => ({ loadDoc: () => state.doc }))
vi.mock('../../db', () => ({ getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: () => state.source }) }) }) }) }))
import { begin, recognize, prepare, save, release, saved } from '../../services/browser/capture'
const rect = { x: 0, y: 0, w: 0.5, h: 0.5 }
beforeEach(() => {
  vi.clearAllMocks()
  state.scope = 'one'
  state.url = 'https://example.com/article'
  state.private = false
  state.sensitive = false
  state.source = { deletedAt: null, aiExcluded: false }
  state.settings.browser.aiBlockedSites = []
  state.settings.ai.chat = { providerId: null, model: null }
  state.ocr.mockResolvedValue(null)
  state.saveTab.mockResolvedValue('source')
  state.saveAnswer.mockReturnValue({ noteId: 'note', created: false, proposalId: 'proposal' })
})
describe('browser region service', () => {
  it('rejects stale scope after OCR and after source persistence', async () => {
    const first = await begin()
    state.ocr.mockImplementationOnce(async () => {
      state.scope = 'two'
      return null
    })
    await expect(recognize(first.id, rect)).rejects.toThrow('Page changed')
    expect(state.saveTab).not.toHaveBeenCalled()
    await release(first.id)
    const second = await begin()
    state.saveTab.mockImplementationOnce(async () => {
      state.scope = 'three'
      return 'source'
    })
    await expect(recognize(second.id, rect)).rejects.toThrow('Page changed')
    await release(second.id)
  })
  it('rejects private pages before capture', async () => {
    state.private = true
    await expect(begin()).rejects.toThrow()
    state.private = false
    state.sensitive = true
    await expect(begin()).rejects.toThrow()
  })
  it('keeps explicit excerpts across navigation but rejects excluded/deleted/blocked sources', async () => {
    const f = await begin()
    await recognize(f.id, rect)
    prepare(f.id, true)
    state.scope = 'new'
    state.url = 'https://example.com/login'
    state.sensitive = true
    expect(prepare(f.id).url).toBe('https://example.com/article')
    await save([{ id: f.id, text: 'manual edit [12]' }], 'note')
    expect(state.saveAnswer.mock.calls[0][0]).toMatchObject({ cue: '', answer: expect.stringContaining('manual edit [12]') })
    await save([{ id: f.id, text: 'manual edit [12]' }], 'note')
    expect(state.saveAnswer).toHaveBeenCalledTimes(1)
    state.source.aiExcluded = true
    expect(() => prepare(f.id)).toThrow()
    state.source.aiExcluded = false
    state.source.deletedAt = 12
    expect(() => prepare(f.id)).toThrow()
    state.source.deletedAt = null
    state.settings.browser.aiBlockedSites = ['example.com']
    expect(() => prepare(f.id)).toThrow()
    await release(f.id)
  })
  it('retains captures after failed save and revalidates privacy after AI cue generation', async () => {
    const f = await begin()
    await recognize(f.id, rect)
    prepare(f.id, true)
    state.saveAnswer.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await expect(save([{ id: f.id, text: 'edit' }], 'note')).rejects.toThrow('disk full')
    expect(prepare(f.id)).toBeTruthy()
    state.settings.ai.chat = { providerId: 'provider', model: 'model' }
    state.structured.mockImplementationOnce(async () => {
      state.source.aiExcluded = true
      return { cue: 'Cue?' }
    })
    await expect(save([{ id: f.id, text: 'edit' }], 'note')).rejects.toThrow('Page changed')
    expect(state.saveAnswer).toHaveBeenCalledTimes(1)
    await release(f.id)
  })
  it('confirms only the persisted proposal row and retries the same save without duplication', async () => {
    const f = await begin()
    await recognize(f.id, rect)
    prepare(f.id, true)
    const receipt = await save([{ id: f.id, text: 'retained edit' }], null)
    const doc = new Y.Doc()
    state.doc = new Uint8Array(Y.encodeStateAsUpdate(doc))
    expect(saved(receipt.proposalId)).toBe(false)
    const row = new Y.XmlElement('cornellRow')
    row.setAttribute('origin', JSON.stringify({ proposalId: receipt.proposalId }))
    doc.getXmlFragment(DOC_FIELD).push([row])
    state.doc = new Uint8Array(Y.encodeStateAsUpdate(doc))
    expect(saved(receipt.proposalId)).toBe(true)
    expect(await save([{ id: f.id, text: 'retained edit' }], 'note')).toEqual(receipt)
    expect(state.saveAnswer).toHaveBeenCalledTimes(1)
    doc.destroy()
    await release(f.id)
  })
  it('coalesces concurrent AI cue saves and freezes the first target note', async () => {
    const f = await begin()
    await recognize(f.id, rect)
    prepare(f.id, true)
    state.settings.ai.chat = { providerId: 'provider', model: 'model' }
    let finish: ((value: { cue: string }) => void) | undefined
    state.structured.mockImplementationOnce(
      () =>
        new Promise<{ cue: string }>((resolve) => {
          finish = resolve
        })
    )
    const first = save([{ id: f.id, text: 'same content' }], 'first-note')
    const second = save([{ id: f.id, text: 'same content' }], 'later-note')
    finish!({ cue: 'Review?' })
    await Promise.all([first, second])
    expect(state.saveAnswer).toHaveBeenCalledTimes(1)
    expect(state.saveAnswer.mock.calls[0][0]).toMatchObject({ noteId: 'first-note', cue: 'Review?' })
    await release(f.id)
  })
})

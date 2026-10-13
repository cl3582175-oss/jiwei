import { afterEach, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ fetch: vi.fn(async () => new Response('visible text')) }))
vi.mock('electron', () => ({ app: { isPackaged: false }, net: network }))
import { externalFetch } from '../../externalFetch'

afterEach(() => {
  vi.useRealTimers()
  network.fetch.mockClear()
})
it('honors a requested interval and retains the existing two-second default', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2030-01-01T10:00:00Z'))
  await externalFetch('https://interval.example/first')
  const second = externalFetch('https://interval.example/second', { minIntervalMs: 1100 })
  await vi.advanceTimersByTimeAsync(1099)
  expect(network.fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(network.fetch).toHaveBeenCalledTimes(2)
  await second
  const third = externalFetch('https://interval.example/third')
  await vi.advanceTimersByTimeAsync(1999)
  expect(network.fetch).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(network.fetch).toHaveBeenCalledTimes(3)
  await third
})

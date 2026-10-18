import { describe, expect, it } from 'vitest'
import { ScrollAxisMemory } from './scrollMemory'

describe('scroll intent survives presentation layout changes', () => {
  it('keeps the inline target when expanded content completely fits', () => {
    const axis = new ScrollAxisMemory(80, 140)
    axis.observe(0, 0)
    expect(axis.target).toBe(80)
  })
  it('keeps the target across partial clamp and later growth', () => {
    const axis = new ScrollAxisMemory(150, 1000)
    axis.observe(50, 50)
    axis.observe(50, 1200)
    expect(axis.target).toBe(150)
  })
  it('retains a new position, including an intentional zero', () => {
    const axis = new ScrollAxisMemory(150, 1000)
    axis.observe(210, 1000)
    expect(axis.target).toBe(210)
    axis.observe(0, 1000)
    expect(axis.target).toBe(0)
  })
  it('preserves the new target if a later resize clamps it', () => {
    const axis = new ScrollAxisMemory(150, 1000)
    axis.observe(210, 1000)
    axis.observe(0, 0)
    expect(axis.target).toBe(210)
  })
  it('does not confuse a restored/clamped position with new intent', () => {
    const axis = new ScrollAxisMemory(150, 1000)
    axis.settle(0, 0)
    axis.observe(0, 0)
    expect(axis.target).toBe(150)
  })
  it('updates each axis independently', () => {
    const x = new ScrollAxisMemory(90, 200),
      y = new ScrollAxisMemory(150, 1000)
    x.observe(0, 0)
    y.observe(0, 1000)
    expect([x.target, y.target]).toEqual([90, 0])
  })
})

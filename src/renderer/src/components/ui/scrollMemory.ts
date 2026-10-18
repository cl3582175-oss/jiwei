/** A layout clamp changes the visible coordinate, not the user's intended reading position. */
export class ScrollAxisMemory {
  target: number
  private position: number
  private max: number

  constructor(position: number, max: number) {
    this.target = this.position = position
    this.max = max
  }

  observe(position: number, max: number): void {
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5
    const rangeChanged = !near(max, this.max)
    const layoutPosition = Math.min(this.position, max)
    if (!near(position, this.position) && (!rangeChanged || !near(position, layoutPosition))) this.target = position
    this.settle(position, max)
  }

  /** Programmatic restoration establishes a new baseline without replacing the desired target. */
  settle(position: number, max: number): void {
    this.position = position
    this.max = max
  }
}

export type Matrix = [number, number, number, number, number, number]
type Point = [number, number]
export type Polygon = Point[]
const EPSILON = 1e-8
const cross = (a: Point, b: Point, p: Point): number => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
const signedArea = (p: Polygon): number =>
  p.reduce((sum, a, i) => {
    const b = p[(i + 1) % p.length]
    return sum + a[0] * b[1] - b[0] * a[1]
  }, 0) / 2

export const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5]
]
export function transformedBox(bounds: number[], m: Matrix): Polygon {
  const [x0, y0, x1, y1] = bounds
  const polygon: Polygon = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1]
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
  return signedArea(polygon) < 0 ? polygon.reverse() : polygon
}
function halfPlane(polygon: Polygon, a: Point, b: Point, inside: boolean): Polygon {
  if (!polygon.length) return []
  const out: Polygon = []
  let previous = polygon.at(-1)!
  let distance = cross(a, b, previous) * (inside ? 1 : -1)
  for (const current of polygon) {
    const next = cross(a, b, current) * (inside ? 1 : -1)
    if (distance >= 0 !== next >= 0) {
      const t = distance / (distance - next)
      out.push([previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t])
    }
    if (next >= 0) out.push(current)
    previous = current
    distance = next
  }
  return out
}
function intersection(subject: Polygon, clip: Polygon): Polygon {
  for (let i = 0; i < clip.length && subject.length; i++) subject = halfPlane(subject, clip[i], clip[(i + 1) % clip.length], true)
  return subject
}
function disjoint(a: Polygon, b: Polygon): boolean {
  const bounds = (p: Polygon): number[] => [
    Math.min(...p.map((v) => v[0])),
    Math.min(...p.map((v) => v[1])),
    Math.max(...p.map((v) => v[0])),
    Math.max(...p.map((v) => v[1]))
  ]
  const x = bounds(a),
    y = bounds(b)
  return x[2] <= y[0] || y[2] <= x[0] || x[3] <= y[1] || y[3] <= x[1]
}
/** 凸多边形相减：只保留未覆盖的片段，避免重复绘制装饰图把面积累加成整页。 */
function subtract(subject: Polygon, clip: Polygon): Polygon[] {
  if (disjoint(subject, clip)) return [subject]
  const out: Polygon[] = []
  for (let i = 0; i < clip.length && subject.length; i++) {
    const a = clip[i],
      b = clip[(i + 1) % clip.length]
    const outside = halfPlane(subject, a, b, false)
    if (Math.abs(signedArea(outside)) > EPSILON) out.push(outside)
    subject = halfPlane(subject, a, b, true)
  }
  return out
}

export class PageImageCoverage {
  private readonly pieces: Polygon[] = []
  private covered = 0
  add(matrix: Matrix, clips: Polygon[]): void {
    if (matrix.some((n) => !Number.isFinite(n))) throw new Error('Invalid PDF image transform')
    let polygon = transformedBox([0, 0, 1, 1], matrix)
    for (const clip of clips) {
      if (clip.length < 3 || Math.abs(signedArea(clip)) < EPSILON) return
      polygon = intersection(polygon, clip)
    }
    if (Math.abs(signedArea(polygon)) < EPSILON) return
    let fresh = [polygon]
    for (const previous of this.pieces) {
      fresh = fresh.flatMap((piece) => subtract(piece, previous))
      if (!fresh.length) return
    }
    this.covered += fresh.reduce((sum, p) => sum + Math.abs(signedArea(p)), 0)
    this.pieces.push(...fresh)
  }
  fraction(pageArea: number): number {
    return pageArea > 0 ? Math.min(1, this.covered / pageArea) : 0
  }
}

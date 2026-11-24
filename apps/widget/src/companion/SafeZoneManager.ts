import type { Point, Rect } from './types.js';

type Size = { width: number; height: number };
const EPS = 1e-7;
const PADDING = 12;
const CONTROL_GAP = 6;
const finitePoint = (point: Point) => Number.isFinite(point.x) && Number.isFinite(point.y);
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Sprite positions are TOP-LEFT coordinates, in the same CSS viewport space as Rect. */
export class SafeZoneManager {
  private viewport!: Rect;
  private sprite!: Size;
  private center!: Rect;
  private controls: Rect[] = [];
  constructor(viewport: Rect, sprite: Size, exclusions: Rect[] = []) { this.update(viewport, sprite, exclusions); }

  update(viewport: Rect, sprite: Size, exclusions: Rect[] = []): void {
    if (![viewport.left, viewport.top, viewport.width, viewport.height, sprite.width, sprite.height].every(Number.isFinite) || viewport.width < 0 || viewport.height < 0 || sprite.width <= 0 || sprite.height <= 0) {
      throw new RangeError('Viewport and sprite dimensions must be finite and positive.');
    }
    this.viewport = { ...viewport }; this.sprite = { ...sprite };
    // Minkowski-expanded rectangles let a line of top-left positions represent
    // the swept WHOLE sprite, not just its center point.
    this.center = this.expand({ left: viewport.left + viewport.width * .18, top: viewport.top + viewport.height * .12, width: viewport.width * .64, height: viewport.height * .70 }, 0);
    this.controls = exclusions.filter(rect => [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0)
      .map(rect => this.expand(rect, CONTROL_GAP));
  }

  /** Peripheral means within the viewport and outside the central content area. */
  isPeripheral(point: Point): boolean { return this.inBounds(point) && !this.inside(point, this.center); }
  isSafe(point: Point): boolean { return this.isPeripheral(point) && !this.controls.some(rect => this.inside(point, rect)); }

  /** At most 116 proposals: inset perimeter strata, a same-height row, and
   * deterministic fallbacks. random is injectable; no rejection-sampling loop. */
  destinations(from: Point, random: () => number = Math.random): Point[] {
    const raw = this.bounds();
    // Round inward before sampling so fractional visual-viewport offsets cannot
    // push a rounded whole sprite beyond the actual padded bounds.
    const bounds = { left: Math.ceil(raw.left), top: Math.ceil(raw.top), right: Math.floor(raw.right), bottom: Math.floor(raw.bottom) };
    if (!finitePoint(from) || bounds.right < bounds.left || bounds.bottom < bounds.top) return [];
    const candidates: Point[] = [];
    const unit = () => {
      let value: number;
      try { value = random(); } catch { return .5; }
      return Number.isFinite(value) ? Math.max(0, Math.min(.999999999, value)) : .5;
    };
    const add = (x: number, y: number) => candidates.push({
      x: Math.max(bounds.left, Math.min(bounds.right, Math.round(x))),
      y: Math.max(bounds.top, Math.min(bounds.bottom, Math.round(y))),
    });
    // These strips are outside the Minkowski-expanded center, so samples cover
    // continuous safe insets instead of repeating just six fixed edge positions.
    const bands = [
      { left: bounds.left, right: bounds.right, top: bounds.top, bottom: Math.min(bounds.bottom, Math.floor(this.center.top)), horizontal: true },
      { left: bounds.left, right: bounds.right, top: Math.max(bounds.top, Math.ceil(this.center.top + this.center.height)), bottom: bounds.bottom, horizontal: true },
      { left: bounds.left, right: Math.min(bounds.right, Math.floor(this.center.left)), top: bounds.top, bottom: bounds.bottom, horizontal: false },
      { left: Math.max(bounds.left, Math.ceil(this.center.left + this.center.width)), right: bounds.right, top: bounds.top, bottom: bounds.bottom, horizontal: false },
    ];
    for (const band of bands) {
      if (band.right < band.left || band.bottom < band.top) continue;
      for (let stratum = 0; stratum < 8; stratum++) for (let inset = 0; inset < 2; inset++) {
        const along = (stratum + unit()) / 8, depth = (inset + unit()) / 2;
        add(band.left + (band.right - band.left) * (band.horizontal ? along : depth),
          band.top + (band.bottom - band.top) * (band.horizontal ? depth : along));
      }
    }
    // Keep exact from.y for the normal integer-position renderer, allowing the
    // controller to retain genuine horizontal electrical routes when safe.
    const row = Math.round(from.y);
    if (row >= bounds.top && row <= bounds.bottom) for (let stratum = 0; stratum < 8; stratum++) {
      add(bounds.left + (bounds.right - bounds.left) * (stratum + unit()) / 8, row);
    }
    for (const progress of [0, .2, .4, .6, .8, 1]) {
      const x = bounds.left + (bounds.right - bounds.left) * progress;
      const y = bounds.top + (bounds.bottom - bounds.top) * progress;
      add(x, bounds.top); add(x, bounds.bottom); add(bounds.left, y); add(bounds.right, y);
    }
    // Include short meaningful steps on the current edge, not only opposite corners.
    for (const step of [24, 32, 64, 112, 176]) for (const sign of [-1, 1]) {
      add(from.x, from.y + sign * step); add(from.x + sign * step, from.y);
    }
    return this.unique(candidates).filter(point => this.isSafe(point) && distance(from, point) >= 24)
      .sort((a, b) => distance(from, a) - distance(from, b));
  }

  /** A visibility graph routes around both the center and explicit controls.
   * escape=true may ignore the center ONLY on the initial outward segment.
   * It never ignores controls, viewport edges, or later center crossings. */
  route(from: Point, to: Point, options: { escape?: boolean } = {}): Point[] | null {
    if (!this.inBounds(from) || !this.isSafe(to) || this.controls.some(rect => this.inside(from, rect))) return null;
    const escaping = options.escape === true && this.inside(from, this.center);
    if (!escaping && !this.isSafe(from)) return null;
    if (distance(from, to) < EPS) return [{ ...from }];
    const blocked = (a: Point, b: Point, ignoreCenter = false) => (!ignoreCenter && this.intersects(a, b, this.center)) || this.controls.some(rect => this.intersects(a, b, rect));
    if (!blocked(from, to, escaping)) return [{ ...from }, { ...to }];
    // Fail closed instead of building an unbounded graph for a pathological host.
    // isSafe still examines every exclusion; no forbidden rectangles are dropped.
    if (this.controls.length > 80) return null;
    const bounds = this.bounds();
    const candidates: Point[] = [from, to,
      { x: bounds.left, y: bounds.top }, { x: bounds.right, y: bounds.top },
      { x: bounds.left, y: bounds.bottom }, { x: bounds.right, y: bounds.bottom }];
    for (const rect of [this.center, ...this.controls]) {
      for (const x of [rect.left - 1, rect.left + rect.width + 1]) for (const y of [rect.top - 1, rect.top + rect.height + 1]) candidates.push({ x, y });
    }
    const points = this.unique(candidates).filter(point => distance(point, from) < EPS || this.isSafe(point));
    const start = points.findIndex(point => distance(point, from) < EPS), finish = points.findIndex(point => distance(point, to) < EPS);
    if (start < 0 || finish < 0) return null;
    const costs = points.map(() => Infinity), previous = points.map(() => -1), visited = new Set<number>();
    costs[start] = 0;
    while (visited.size < points.length) {
      let current = -1, score = Infinity;
      for (let i = 0; i < points.length; i++) if (!visited.has(i) && costs[i]! + distance(points[i]!, to) < score) { current = i; score = costs[i]! + distance(points[i]!, to); }
      if (current < 0 || !Number.isFinite(costs[current])) return null;
      if (current === finish) {
        const result: Point[] = []; let index = finish;
        while (index >= 0) { result.push({ ...points[index]! }); index = previous[index]!; }
        return result.reverse();
      }
      visited.add(current);
      for (let next = 0; next < points.length; next++) {
        if (visited.has(next) || next === current || blocked(points[current]!, points[next]!, escaping && current === start)) continue;
        const cost = costs[current]! + distance(points[current]!, points[next]!);
        if (cost + EPS < costs[next]!) { costs[next] = cost; previous[next] = current; }
      }
    }
    return null;
  }

  private expand(rect: Rect, gap: number): Rect { return { left: rect.left - this.sprite.width - gap, top: rect.top - this.sprite.height - gap, width: rect.width + this.sprite.width + gap * 2, height: rect.height + this.sprite.height + gap * 2 }; }
  private bounds() { return { left: this.viewport.left + PADDING, top: this.viewport.top + PADDING, right: this.viewport.left + this.viewport.width - this.sprite.width - PADDING, bottom: this.viewport.top + this.viewport.height - this.sprite.height - PADDING }; }
  private inBounds(point: Point): boolean { const b = this.bounds(); return finitePoint(point) && point.x >= b.left && point.x <= b.right && point.y >= b.top && point.y <= b.bottom; }
  private inside(point: Point, rect: Rect): boolean { return point.x > rect.left + EPS && point.x < rect.left + rect.width - EPS && point.y > rect.top + EPS && point.y < rect.top + rect.height - EPS; }
  private intersects(from: Point, to: Point, rect: Rect): boolean {
    let enter = 0, exit = 1;
    for (const [value, change, min, max] of [[from.x, to.x - from.x, rect.left, rect.left + rect.width], [from.y, to.y - from.y, rect.top, rect.top + rect.height]]) {
      if (Math.abs(change!) < EPS) { if (value! <= min! + EPS || value! >= max! - EPS) return false; continue; }
      const a = (min! - value!) / change!, b = (max! - value!) / change!;
      enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
      if (enter >= exit - EPS) return false;
    }
    return exit > EPS && enter < 1 - EPS;
  }
  private unique(points: Point[]): Point[] {
    const seen = new Set<string>();
    return points.filter(point => { const key = `${point.x.toFixed(3)},${point.y.toFixed(3)}`; if (!finitePoint(point) || seen.has(key)) return false; seen.add(key); return true; }).map(point => ({ ...point }));
  }
}

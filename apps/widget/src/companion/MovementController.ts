import type { Point } from './types.js';

export interface MovementUpdate { position: Point; done: boolean; facing: -1 | 1; }

/** Caller owns the single animation clock; this class never creates timers or RAF. */
export class MovementController {
  static landingOffset(elapsedMs: number, initialVelocityY = 0): number { return landingOffset(elapsedMs, initialVelocityY); }
  private route: Point[] = [];
  private lengths: number[] = [];
  private total = 0;
  private started = 0;
  private duration = 0;
  private moving = false;
  private position: Point = { x: 0, y: 0 };
  private facing: -1 | 1 = 1;
  private segment = 0;
  get active() { return this.moving; }
  get remainingRoute(): Point[] { return this.moving ? [{ ...this.position }, ...this.route.slice(this.segment + 1).map(point => ({ ...point }))] : []; }

  start(route: Point[], now: number, speed = 170): void {
    this.cancel();
    const points = route.map(point => ({ ...point }));
    if (!Number.isFinite(now) || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return;
    this.route = points.filter((point, index) => index === 0 || Math.hypot(point.x - points[index - 1]!.x, point.y - points[index - 1]!.y) > .001);
    if (!this.route.length) return;
    this.position = this.integer(this.route[0]!); this.segment = 0;
    this.lengths = this.route.slice(1).map((point, index) => Math.hypot(point.x - this.route[index]!.x, point.y - this.route[index]!.y));
    this.total = this.lengths.reduce((sum, length) => sum + length, 0);
    if (!this.total) return;
    const velocity = Number.isFinite(speed) && speed > 0 ? Math.max(20, Math.min(10_000, speed)) : 170;
    // speed is nominal average CSS px/sec; smoothstep adds gentle acceleration
    // and deceleration without changing the caller's intended arrival time.
    this.duration = Math.max(180, this.total * 1000 / velocity);
    this.started = now; this.moving = true;
  }

  update(now: number): MovementUpdate {
    if (!this.moving || !Number.isFinite(now)) return { position: { ...this.position }, done: !this.moving, facing: this.facing };
    const progress = Math.max(0, Math.min(1, (now - this.started) / this.duration));
    let travelled = (progress * progress * (3 - 2 * progress)) * this.total;
    let segment = 0;
    while (segment < this.lengths.length - 1 && travelled > this.lengths[segment]!) { travelled -= this.lengths[segment]!; segment++; }
    const a = this.route[segment]!, b = this.route[segment + 1]!;
    const fraction = Math.min(1, travelled / this.lengths[segment]!);
    const deltaX = b.x - a.x;
    if (Math.abs(deltaX) > .1) this.facing = deltaX < 0 ? -1 : 1;
    this.position = this.integer({ x: a.x + deltaX * fraction, y: a.y + (b.y - a.y) * fraction });
    this.segment = segment;
    if (progress >= 1) { this.position = this.integer(this.route[this.route.length - 1]!); this.moving = false; }
    return { position: { ...this.position }, done: !this.moving, facing: this.facing };
  }

  cancel(): void { this.moving = false; this.route = []; this.lengths = []; this.total = 0; this.segment = 0; }
  private integer(point: Point): Point { return { x: Math.round(point.x), y: Math.round(point.y) }; }
}

/** A small damped fall/bounce, bounded to ten CSS pixels and exactly settled at 480ms. */
export function landingOffset(elapsedMs: number, initialVelocityY = 0): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= 480) return 0;
  const time = elapsedMs / 1000;
  const velocity = Number.isFinite(initialVelocityY) ? Math.max(-300, Math.min(300, initialVelocityY)) : 0;
  const amplitude = 7 + Math.abs(velocity) / 100;
  return Math.round(Math.max(-10, Math.min(10, amplitude * Math.exp(-7 * time) * Math.sin(18 * time))));
}

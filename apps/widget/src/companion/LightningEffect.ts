import type { Point, Rect } from './types.js';

export const BLINK_TIMING = Object.freeze({ prepare: 120, reveal: 300, total: 500 });
const DRAW_INTERVAL = 33;
const CYAN = '#35fff0', GREEN = '#35ff99', MAGENTA = '#ff007b';
let activationSequence = 0;
interface Layer { pixels: Int16Array; color: string; alpha: number; reveal: number; }
function generator(seed: number) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

/** Seeded horizontal pixel discharge. Cached geometry never rerolls on a frame;
 * the canvas is a narrow band, never a viewport-sized buffer. */
export class LightningEffect {
  private canvas?: HTMLCanvasElement;
  private context?: CanvasRenderingContext2D;
  private from: Point = { x: 0, y: 0 };
  private to: Point = { x: 0, y: 0 };
  private layers: Layer[] = [];
  private sourceSparks: Int16Array = new Int16Array(0);
  private targetSparks: Int16Array = new Int16Array(0);
  private started = 0;
  private lastDraw = -Infinity;
  private seed = 0;
  private destroyed = false;
  constructor(private readonly ownerDocument: Document | undefined = globalThis.document) {}
  get active(): boolean { return this.canvas !== undefined; }

  start(route: Point[], viewport: Rect, now: number): void {
    this.cancel();
    if (this.destroyed || !this.ownerDocument?.body || !Number.isFinite(now) || route.length !== 2 ||
      route.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)) ||
      ![viewport.left, viewport.top, viewport.width, viewport.height].every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) return;
    const [from, to] = route as [Point, Point];
    if (Math.abs(from.y - to.y) > 1 || Math.abs(from.x - to.x) < 1) return;
    const left = Math.max(viewport.left, Math.floor(Math.min(from.x, to.x) - 8));
    const right = Math.min(viewport.left + viewport.width, Math.ceil(Math.max(from.x, to.x) + 8));
    const top = Math.max(viewport.top, Math.floor(from.y - 10));
    const bottom = Math.min(viewport.top + viewport.height, Math.ceil(from.y + 12));
    if (right <= left || bottom <= top || right - left > 8192) return;
    const canvas = this.ownerDocument.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true'); canvas.setAttribute('data-kari-lightning', '');
    canvas.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${right-left}px;height:${bottom-top}px;pointer-events:none;z-index:2147481999;image-rendering:pixelated;contain:strict;`;
    canvas.width = Math.ceil(right - left); canvas.height = Math.ceil(bottom - top);
    let context: CanvasRenderingContext2D | null;
    try { context = canvas.getContext('2d', { alpha: true }); } catch { return; }
    if (!context) return;
    context.imageSmoothingEnabled = false;
    this.canvas = canvas; this.context = context; this.started = now; this.lastDraw = -Infinity;
    this.from = this.bound({ x: from.x - left, y: from.y - top });
    this.to = this.bound({ x: to.x - left, y: from.y - top });
    // Sequence salt preserves variety even when a host or test fixes Math.random.
    const randomSeed = Math.floor((Math.random() || 0) * 4294967296) >>> 0;
    this.seed = (randomSeed ^ Math.imul(++activationSequence, 0x9e3779b1) ^ Math.imul(Math.round(from.x), 31) ^ Math.round(to.x)) >>> 0;
    this.buildGeometry();
    this.ownerDocument.body.append(canvas); this.update(now);
  }

  update(now: number): void {
    const context = this.context, canvas = this.canvas;
    if (!context || !canvas || !Number.isFinite(now)) return;
    const elapsed = Math.max(0, now - this.started);
    // Expiration bypasses the drawing cap, even one millisecond after a repaint.
    if (elapsed >= BLINK_TIMING.total) { this.cancel(); return; }
    if (now - this.lastDraw < DRAW_INTERVAL) return;
    this.lastDraw = now;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const phase = Math.floor(elapsed / 60);
    try {
      if (elapsed < BLINK_TIMING.prepare) { this.paint(this.sourceSparks, CYAN, .45 + .12 * (phase % 2), 1, phase); return; }
      const fade = elapsed < BLINK_TIMING.reveal ? 1 : Math.pow((BLINK_TIMING.total - elapsed) / (BLINK_TIMING.total - BLINK_TIMING.reveal), 1.5);
      const reveal = Math.min(1, (elapsed - BLINK_TIMING.prepare) / 60 + .18);
      for (let index = 0; index < this.layers.length; index++) {
        const layer = this.layers[index]!;
        if (reveal < layer.reveal) continue;
        const pulse = index === 0 ? 1 : .78 + .11 * ((phase + index + (this.seed & 3)) % 3);
        const residual = index === 0 ? fade : fade * fade;
        this.paint(layer.pixels, layer.color, layer.alpha * pulse * residual, reveal);
      }
      this.paint(this.targetSparks, GREEN, .8 * fade, reveal >= .95 ? 1 : 0, phase);
      if (elapsed >= BLINK_TIMING.reveal) this.paint(this.sourceSparks, MAGENTA, .3 * fade, 1, phase + 1);
    } finally { context.globalAlpha = 1; }
  }

  cancel(): void {
    this.canvas?.remove(); this.canvas = undefined; this.context = undefined;
    this.layers = []; this.sourceSparks = new Int16Array(0); this.targetSparks = new Int16Array(0); this.lastDraw = -Infinity;
  }
  destroy(): void { this.cancel(); this.destroyed = true; }

  private buildGeometry() {
    const random = generator(this.seed), variant = Math.floor(random() * 3);
    const direction = this.to.x >= this.from.x ? 1 : -1;
    const length = Math.abs(this.to.x - this.from.x);
    const segments = Math.max(3, Math.min(180, Math.ceil(length / 20)));
    const weights = Array.from({ length: segments }, () => .65 + random() * .9);
    const total = weights.reduce((sum, value) => sum + value, 0);
    const main: Point[] = [this.from];
    let at = 0, wander = 0;
    const arch = random() < .5 ? -1 : 1;
    for (let i = 0; i < segments; i++) {
      at += weights[i]!;
      const t = at / total;
      wander = Math.max(-4.5, Math.min(4.5, wander * .58 + (random() - .5) * 6));
      const kink = (wander + (random() - .5) * 2 + (variant === 1 ? arch * 2.5 : 0)) * Math.sin(Math.PI * t);
      main.push(i === segments - 1 ? this.to : this.bound({ x: this.from.x + direction * length * t, y: this.from.y + kink }));
    }
    this.layers.push({ pixels: this.raster(main, variant === 2 ? random : undefined), color: CYAN, alpha: .92, reveal: 0 });
    const echo = main.map((point, i) => this.bound({ x: point.x + (i % 3 === 1 ? direction : 0), y: point.y + (i === 0 || i === main.length - 1 ? 0 : arch * 2) }));
    this.layers.push({ pixels: this.raster(echo, random), color: MAGENTA, alpha: .43, reveal: .2 });
    if (variant === 1) {
      const arc = main.map((point, i) => this.bound({ x: point.x, y: this.from.y - arch * 4 * Math.sin(Math.PI * i / segments) + (random() - .5) * 2 }));
      this.layers.push({ pixels: this.raster(arc), color: GREEN, alpha: .55, reveal: .35 });
    }
    const branches = Math.min(8, Math.max(2, Math.floor(length / 75)));
    for (let i = 0; i < branches; i++) {
      const index = 1 + Math.floor(random() * Math.max(1, main.length - 2));
      const root = main[index]!;
      const sign = random() < .5 ? -1 : 1;
      const extent = 5 + Math.floor(random() * 12), rise = sign * (3 + random() * 5);
      const branch = [root, this.bound({ x: root.x - direction * extent * .45, y: root.y + rise * .5 }), this.bound({ x: root.x - direction * extent, y: root.y + rise })];
      this.layers.push({ pixels: this.raster(branch), color: i % 2 ? MAGENTA : GREEN, alpha: .5 + random() * .25, reveal: .2 + random() * .5 });
      if (variant === 0 && i % 2 === 0) this.layers.push({ pixels: this.raster([branch[1]!, this.bound({ x: root.x + direction * extent * .35, y: root.y - rise * .65 })]), color: CYAN, alpha: .44, reveal: .35 });
    }
    this.sourceSparks = this.sparks(this.from, random); this.targetSparks = this.sparks(this.to, random);
  }
  private bound(point: Point): Point {
    return { x: Math.round(Math.max(0, Math.min(this.canvas!.width - 2, point.x))), y: Math.round(Math.max(0, Math.min(this.canvas!.height - 1, point.y))) };
  }
  private sparks(origin: Point, random: () => number): Int16Array {
    const pixels: number[] = [];
    for (let i = 0; i < 9; i++) { const point = this.bound({ x: origin.x + (random() - .5) * 14, y: origin.y + (random() - .5) * 14 }); pixels.push(point.x, point.y); }
    return Int16Array.from(pixels);
  }
  private raster(points: Point[], gaps?: () => number): Int16Array {
    const pixels: number[] = [];
    for (let segment = 1; segment < points.length; segment++) {
      if (gaps && segment > 1 && segment < points.length - 1 && gaps() < .2) continue;
      const from = points[segment - 1]!, to = points[segment]!;
      let x = from.x, y = from.y;
      const dx = Math.abs(to.x - x), dy = -Math.abs(to.y - y), sx = x < to.x ? 1 : -1, sy = y < to.y ? 1 : -1;
      let error = dx + dy;
      while (true) {
        pixels.push(x, y);
        if (x === to.x && y === to.y) break;
        const doubled = error * 2;
        if (doubled >= dy) { error += dy; x += sx; }
        if (doubled <= dx) { error += dx; y += sy; }
      }
    }
    return Int16Array.from(pixels);
  }
  private paint(pixels: Int16Array, color: string, alpha: number, reveal: number, sparkPhase?: number) {
    const context = this.context!;
    context.fillStyle = color; context.globalAlpha = Math.max(0, Math.min(1, alpha));
    const end = Math.floor(pixels.length / 2 * reveal) * 2;
    for (let i = 0; i < end; i += 2) { if (sparkPhase !== undefined && (i / 2 + sparkPhase) % 3 === 0) continue; context.fillRect(pixels[i]!, pixels[i + 1]!, 2, 1); }
  }
}

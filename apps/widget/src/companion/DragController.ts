import type { Point, Rect } from './types.js';

export interface DragSession {
  id: number; startX: number; startY: number; x: number; y: number;
  left: number; top: number; active: boolean; velocityX: number; velocityY: number;
}
interface DragHooks {
  bounds(): Rect;
  begin(): void;
  lift(): void;
  move(position: Point, velocity: Point): void;
  release(cancelled: boolean, session: DragSession): void;
}

/** Pointer capture, grab offsets and velocity belong here; no navigation or visual effects. */
export class DragController {
  private current?: DragSession;
  private holdTimer?: ReturnType<typeof setTimeout>;
  private previousTime = 0;
  private suppressClick = false;
  constructor(private readonly handle: HTMLElement, private readonly hooks: DragHooks) {}
  get session() { return this.current; }
  get active() { return this.current?.active === true; }
  begin(event: PointerEvent): void {
    if (event.button !== 0 || event.isPrimary === false || this.current) return;
    const rect = this.hooks.bounds();
    this.suppressClick = false;
    this.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, active: false, velocityX: 0, velocityY: 0 };
    this.previousTime = performance.now(); this.hooks.begin();
    try { this.handle.setPointerCapture(event.pointerId); } catch { /* Window pointer listeners remain available. */ }
    this.holdTimer = setTimeout(() => { this.holdTimer = undefined; this.lift(); }, 320);
  }
  private lift(): void {
    if (!this.current || this.current.active) return;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = undefined; this.current.active = true; this.hooks.lift();
  }
  move(event: PointerEvent): void {
    const drag = this.current;
    if (!drag || drag.id !== event.pointerId) return;
    const now = performance.now(), elapsed = Math.max(8, now - this.previousTime);
    drag.velocityX = drag.velocityX * .65 + (event.clientX - drag.x) / elapsed * 350;
    drag.velocityY = drag.velocityY * .65 + (event.clientY - drag.y) / elapsed * 350;
    drag.x = event.clientX; drag.y = event.clientY; this.previousTime = now;
    if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
    this.lift(); event.preventDefault();
    this.hooks.move({ x: drag.left + drag.x - drag.startX, y: drag.top + drag.y - drag.startY }, { x: drag.velocityX, y: drag.velocityY });
  }
  end(cancelled: boolean): void {
    const drag = this.current;
    if (!drag) return;
    this.current = undefined;
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    try { if (this.handle.hasPointerCapture?.(drag.id)) this.handle.releasePointerCapture(drag.id); } catch { /* Capture may disappear with the element. */ }
    if (drag.active) this.suppressClick = true;
    this.hooks.release(cancelled, drag);
  }
  consumeClick(event: MouseEvent): boolean {
    const consumed = this.suppressClick && event.detail !== 0;
    this.suppressClick = false; return consumed;
  }
  destroy(): void { this.end(true); }
}

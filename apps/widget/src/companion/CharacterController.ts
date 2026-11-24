import { BehaviorSystem } from './BehaviorSystem.js';
import { AnimationController } from './AnimationController.js';
import { ConversationReactions } from './ConversationReactions.js';
import { SpriteRenderer } from './SpriteRenderer.js';
import { SafeZoneManager } from './SafeZoneManager.js';
import { landingOffset } from './MovementController.js';
import { LightningEffect, BLINK_TIMING } from './LightningEffect.js';
import type { BehaviorConfig, CharacterState, Direction, Point, Rect } from './types.js';

export interface CharacterOptions {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  position(): Rect;
  move(point: Point): void;
  viewport(): Rect;
  exclusions(): Rect[];
  canPlace?(rect: Rect): boolean;
  interactionBlocked(): boolean;
  glitch(): boolean;
  stateChanged(state: CharacterState): void;
}
const asleep = (state: CharacterState) => state === 'SLEEP' || state === 'SLEEP_TALK';
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Coordinates one FSM and one bounded rendering loop. No AI calls or stored personal data. */
export class CharacterController {
  readonly behavior: BehaviorSystem;
  readonly config: BehaviorConfig;
  private readonly animation = new AnimationController();
  private readonly reactions = new ConversationReactions();
  private readonly renderer: SpriteRenderer;
  private readonly navigation: SafeZoneManager;
  private readonly lightning: LightningEffect;
  private raf?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private suspended = false;
  private reduced = false;
  private calm = false;
  private mobile = false;
  private pinned = false;
  private roaming = true;
  private lastActivity = performance.now();
  private lastInput = -Infinity;
  private pointerUntil = 0;
  private lastCursor = 0;
  private nextMove = Infinity;
  private manualAt?: number;
  private dragging = false;
  private landingAt = -Infinity;
  private landingVelocity = 0;
  private lastDraw = -Infinity;
  private lastTick = 0;
  private gaze: Direction = 0;
  private lean: Direction = 0;
  private dragMotionAt = -Infinity;
  private facing: Direction = 1;
  private requestState = 'idle';
  private talkingUntil = 0;
  private conversationOpen = false;
  private relocation?: { target: Point; startedAt: number; phase: 'prepare' | 'hidden' | 'arrive'; phaseStartedAt: number; committed: boolean; explicit: boolean; onCommit?: () => void };
  private nextNavigationAttempt = 0;
  private recentStops: Point[] = [];
  private lastState?: CharacterState;
  private lastGeometry = -Infinity;
  private destroyed = false;

  constructor(private readonly options: CharacterOptions, config: Partial<BehaviorConfig> = {}) {
    this.behavior = new BehaviorSystem(config);
    this.config = this.behavior.config;
    this.renderer = new SpriteRenderer(options.canvas);
    const viewport = options.viewport(), sprite = options.position();
    this.navigation = new SafeZoneManager(viewport, sprite, options.exclusions());
    this.lightning = new LightningEffect(options.host.ownerDocument);
    this.nextMove = performance.now() + this.randomMoveDelay();
  }
  get state(): CharacterState { return this.behavior.snapshot.state; }
  get allowsGlitch(): boolean {
    return !this.dragging && !this.relocation && performance.now() - this.landingAt > 5000 && !asleep(this.state) && !['YAWN', 'WAKE_UP'].includes(this.state);
  }
  start(): void {
    if (this.destroyed || this.running) return;
    this.running = true; this.behavior.reset(performance.now()); this.lastTick = performance.now(); this.redraw(); this.schedule();
  }
  destroy(): void {
    this.destroyed = true; this.running = false; this.cancelFrame(); this.cancelMovement(); this.lightning.destroy();
    this.options.host.removeAttribute('data-behavior'); this.options.host.removeAttribute('data-moving');
    this.options.host.removeAttribute('data-lightning');
    this.options.host.removeAttribute('data-relocation-phase');
  }
  preferences(preferences: { suspended: boolean; reduced: boolean; calm: boolean; mobile: boolean; pinned: boolean; roaming: boolean; open: boolean }): void {
    const changed = this.suspended !== preferences.suspended || this.reduced !== preferences.reduced || this.calm !== preferences.calm;
    this.suspended = preferences.suspended; this.reduced = preferences.reduced; this.calm = preferences.calm;
    this.mobile = preferences.mobile; this.pinned = preferences.pinned; this.roaming = preferences.roaming; this.conversationOpen = preferences.open;
    if (this.suspended || this.reduced || this.calm || (this.pinned && !this.relocation?.explicit)) this.cancelMovement();
    if (changed) { this.cancelFrame(); this.lastTick = performance.now(); this.redraw(); this.schedule(); }
  }
  activity(typing = false): void {
    const now = performance.now(); this.lastActivity = now;
    if (typing) { this.lastInput = now; this.wake(); this.cancelMovement(); }
    if (!asleep(this.state) && this.state !== 'WAKE_UP' && !this.dragging && typing) this.behavior.force('LISTEN', now, 2200);
    this.redraw();
  }
  wake(): number {
    const now = performance.now(); this.lastActivity = now; this.cancelMovement();
    const remaining = this.behavior.wake(now); this.redraw(); this.schedule(); return remaining;
  }
  cursor(x: number, y: number): void {
    const now = performance.now();
    if (now - this.lastCursor < 900 || this.dragging || asleep(this.state)) return;
    this.lastCursor = now;
    const rect = this.options.position(), center = rect.left + rect.width / 2;
    if (Math.hypot(x - center, y - rect.top - rect.height / 2) < 170) {
      this.gaze = x < center - 12 ? -1 : x > center + 12 ? 1 : 0; this.pointerUntil = now + 1800;
    }
  }
  conversation(state: string, text = '', metadata?: { emotion?: unknown; intent?: unknown }): void {
    if (state === this.requestState && !text) return;
    this.requestState = state;
    const now = performance.now();
    this.talkingUntil = state === 'talk' ? now + 4500 : 0;
    if (state !== 'idle') { this.lastActivity = now; if (!this.relocation?.explicit) this.cancelMovement(); }
    const reaction = this.reactions.resolve({ thinking: state === 'think', talking: state === 'talk', text, metadata, metadataTrusted: metadata !== undefined });
    if (state !== 'idle' || text) this.behavior.force(reaction, now, state === 'talk' ? 4500 : state === 'think' ? 4000 : undefined);
    this.redraw();
  }
  dragStart(): void {
    this.dragging = true; this.lean = 0; this.dragMotionAt = -Infinity; this.manualAt = undefined; this.lastInput = -Infinity; this.landingAt = -Infinity; this.landingVelocity = 0; this.cancelMovement(); this.wake();
    this.behavior.force('DRAGGED', performance.now(), Infinity); this.redraw();
  }
  dragVelocity(velocity: Point): void { this.dragMotionAt = performance.now(); this.lean = Math.abs(velocity.x) < 30 ? 0 : velocity.x > 0 ? 1 : -1; this.redraw(); }
  dragEnd(cancelled: boolean, velocityY = 0): void {
    this.dragging = false; this.lean = 0; const now = performance.now(); this.lastActivity = now;
    if (cancelled) this.behavior.force('IDLE', now, 1800);
    else {
      this.manualAt = now; this.landingAt = now; this.landingVelocity = velocityY;
      this.behavior.force('LANDED', now, 650);
    }
    this.nextMove = now + this.randomMoveDelay(); this.redraw(); this.schedule();
  }
  geometryChanged(): void { this.cancelMovement(); this.lastGeometry = -Infinity; this.refreshGeometry(performance.now(), true); this.redraw(); }
  redraw(): void {
    if (this.destroyed || this.suspended) return;
    const now = performance.now();
    if (this.reduced || this.calm) this.behavior.update(this.environment(now));
    this.draw(now, true);
  }

  private refreshGeometry(now: number, force = false): void {
    if (!force && now - this.lastGeometry < 1000) return;
    this.lastGeometry = now;
    this.navigation.update(this.options.viewport(), this.options.position(), this.options.exclusions());
  }
  private environment(now: number) {
    const rect = this.options.position(), viewport = this.options.viewport();
    const point = { x: rect.left, y: rect.top };
    const bottomEdge = rect.top + rect.height >= viewport.top + viewport.height - 28;
    return { now, lastInteraction: this.lastActivity, typing: now - this.lastInput < 2200, thinking: this.requestState === 'think', talking: this.requestState === 'talk' && now < this.talkingUntil, dragged: this.dragging, landed: now - this.landingAt < 650, pointerNear: now < this.pointerUntil, bottomEdge, moving: !!this.relocation, reduced: this.reduced || this.calm, canMove: this.canMove() && (!!this.relocation || now >= this.nextMove), homeSafe: bottomEdge && this.navigation.isSafe(point) };
  }
  private canMove(): boolean {
    return this.running && !this.suspended && !this.reduced && !this.calm && !this.pinned && !this.dragging && !asleep(this.state) && this.state !== 'WAKE_UP' && performance.now() - this.landingAt >= 7000 && performance.now() - this.lastInput >= 2200 && !this.options.interactionBlocked() && this.requestState !== 'think' && !(this.requestState === 'talk' && performance.now() < this.talkingUntil);
  }
  private randomMoveDelay(): number { return (this.config.moveMinMs + Math.random() * Math.max(0, this.config.moveMaxMs - this.config.moveMinMs)) * (this.mobile ? 1.5 : 1); }
  private rememberStop(point: Point): void {
    if (this.recentStops.length && distance(this.recentStops[this.recentStops.length - 1]!, point) < 8) return;
    this.recentStops.push({ ...point }); this.recentStops = this.recentStops.slice(-8);
  }
  private cancelMovement(): void {
    this.relocation = undefined; this.lightning.cancel();
    this.options.host.removeAttribute('data-moving'); this.options.host.removeAttribute('data-lightning');
    this.options.host.removeAttribute('data-relocation-phase');
  }
  /** Commands and autonomy share one blink. Only a clear horizontal corridor
   * gets a line; every destination still validates the entire character box. */
  relocate(target: Point, explicit = false, onCommit?: () => void): boolean {
    if (this.destroyed || !this.running || this.suspended || this.dragging || (!explicit && !this.canMove())) return false;
    this.refreshGeometry(performance.now(), true);
    const rect = this.options.position(), from = { x: rect.left, y: rect.top };
    const destination = { x: Math.round(target.x), y: Math.round(target.y) };
    if (!this.navigation.isSafe(destination) || distance(from, destination) < 2 || this.options.canPlace?.({ ...rect, left: destination.x, top: destination.y }) === false) return false;
    const viewport = this.options.viewport();
    this.cancelMovement(); this.manualAt = undefined;
    const now = performance.now(); this.nextMove = now + this.randomMoveDelay();
    this.rememberStop(from);
    if (this.reduced || this.calm) { this.options.move(destination); this.rememberStop(destination); onCommit?.(); this.redraw(); return true; }
    const horizontal = Math.abs(destination.y - from.y) <= 1 && Math.abs(destination.x - from.x) >= 24;
    const lineFrom = { x: from.x + rect.width / 2, y: from.y + rect.height / 2 };
    const lineTo = { x: destination.x + rect.width / 2, y: lineFrom.y };
    // The avatar teleports; only the thin electrical band sweeps the corridor.
    const lineZone = horizontal ? new SafeZoneManager(viewport, { width: 1, height: 22 }, this.options.exclusions()) : undefined;
    const route = lineZone?.route({ x: lineFrom.x, y: lineFrom.y - 11 }, { x: lineTo.x, y: lineTo.y - 11 });
    this.relocation = { target: destination, startedAt: now, phase: 'prepare', phaseStartedAt: now, committed: false, explicit, onCommit };
    this.options.host.setAttribute('data-moving', '');
    this.options.host.setAttribute('data-relocation-phase', 'prepare');
    this.options.host.removeAttribute('data-glitch');
    if (asleep(this.state) || ['DRAGGED', 'LANDED', 'WAKE_UP'].includes(this.state)) this.behavior.force('IDLE', now);
    if (route?.length === 2) {
      this.options.host.setAttribute('data-lightning', '');
      this.lightning.start([lineFrom, lineTo], viewport, now);
    }
    this.redraw(); this.cancelFrame(); this.schedule();
    return true;
  }
  /** Generic move commands use the same varied coordinates as autonomous blinks. */
  relocateRandom(): boolean { return this.chooseMovement(performance.now(), false, true); }
  private chooseMovement(now: number, returnHome = false, explicit = false): boolean {
    if (this.destroyed || !this.running || this.suspended || this.dragging || (!explicit && (!this.canMove() || now < this.nextNavigationAttempt)) || this.relocation) return false;
    this.nextNavigationAttempt = now + 2000;
    this.refreshGeometry(now, true);
    const rect = this.options.position(), from = { x: rect.left, y: rect.top }, viewport = this.options.viewport();
    const targets = this.navigation.destinations(from).filter(point => !returnHome || point.y + rect.height >= viewport.top + viewport.height - 28);
    if (!targets.length) { this.nextMove = now + 2000; return false; }
    const separation = Math.min(120, Math.max(32, Math.min(viewport.width, viewport.height) * .14));
    const history = [from, ...this.recentStops];
    const fresh = new Set(targets.filter(point => history.every(previous => distance(previous, point) >= separation)));
    // Choose a distance afresh, rather than cycling near/middle/far in order.
    const reach = Math.hypot(viewport.width, viewport.height);
    const preferred = reach * (.1 + Math.random() * .75);
    const edge = (point: Point) => {
      const gaps = [point.x - viewport.left, viewport.left + viewport.width - point.x - rect.width, point.y - viewport.top, viewport.top + viewport.height - point.y - rect.height];
      return gaps.indexOf(Math.min(...gaps));
    };
    const horizontal = targets.filter(point => Math.abs(point.y - from.y) <= 1);
    const preferHorizontal = horizontal.length > 0 && Math.random() < .35 && !returnHome;
    const pool = targets.map(point => {
      const travelled = distance(from, point);
      const familiarity = Math.min(Infinity, ...this.recentStops.map(previous => distance(previous, point)));
      const novelty = familiarity < separation ? .1 : 1;
      const visits = this.recentStops.filter(previous => edge(previous) === edge(point)).length;
      const weight = (0.25 + 1 / (1 + Math.abs(travelled - preferred) / Math.max(80, preferred * .5))) * novelty / (1 + visits * .7);
      return { point, weight, fresh: fresh.has(point) };
    });
    for (let attempt = 0; attempt < 12 && pool.length; attempt++) {
      // Reserve fallback checks for familiar stops when projected chat bounds
      // reject otherwise fresh sprite positions. Never exceed 12 placements.
      const preferredPool = pool.filter(candidate => candidate.fresh === (attempt < 8));
      const available = preferredPool.length ? preferredPool : pool;
      const row = preferHorizontal && attempt < 6 ? available.filter(candidate => Math.abs(candidate.point.y - from.y) <= 1) : [];
      const selection = row.length ? row : available;
      let draw = Math.random() * selection.reduce((sum, candidate) => sum + candidate.weight, 0);
      const selected = selection.find(candidate => (draw -= candidate.weight) < 0) ?? selection[selection.length - 1]!;
      const index = pool.indexOf(selected);
      const [candidate] = pool.splice(index, 1);
      if (this.relocate(candidate!.point, explicit)) return true;
    }
    this.nextMove = now + 2000; return false;
  }
  private updateMovement(now: number): void {
    const relocation = this.relocation;
    if (!relocation) return;
    if (!relocation.explicit && !this.canMove()) { this.cancelMovement(); return; }
    const elapsed = Math.max(0, now - relocation.phaseStartedAt);
    if (relocation.phase === 'prepare' && elapsed >= BLINK_TIMING.prepare) {
      relocation.phase = 'hidden'; relocation.phaseStartedAt = now;
      this.options.host.setAttribute('data-relocation-phase', 'hidden');
      if (this.lightning.active) this.lightning.update(relocation.startedAt + BLINK_TIMING.prepare);
      return; // Give the browser a frame with KARI absent at the origin.
    }
    if (relocation.phase === 'hidden' && elapsed >= BLINK_TIMING.reveal - BLINK_TIMING.prepare) {
      this.refreshGeometry(now, true);
      const box = { ...this.options.position(), left: relocation.target.x, top: relocation.target.y };
      if (!this.navigation.isSafe(relocation.target) || this.options.canPlace?.(box) === false) {
        this.cancelMovement(); this.nextMove = now + 2000; return;
      }
      relocation.committed = true;
      this.options.move(relocation.target); this.rememberStop(relocation.target); relocation.onCommit?.();
      relocation.phase = 'arrive'; relocation.phaseStartedAt = now;
      this.options.host.setAttribute('data-relocation-phase', 'arrive');
      if (this.lightning.active) this.lightning.update(relocation.startedAt + BLINK_TIMING.reveal);
      return;
    }
    if (relocation.phase === 'arrive' && elapsed >= BLINK_TIMING.total - BLINK_TIMING.reveal) {
      this.cancelMovement(); this.nextMove = now + this.randomMoveDelay(); this.facing = 1; return;
    }
    if (this.lightning.active) {
      const offset = relocation.phase === 'prepare' ? 0 : relocation.phase === 'hidden' ? BLINK_TIMING.prepare : BLINK_TIMING.reveal;
      this.lightning.update(relocation.startedAt + offset + elapsed);
    }
  }
  private tick = (now: number): void => {
    this.raf = undefined;
    if (!this.running || this.destroyed || this.suspended || this.reduced || this.calm) return;
    const delta = Math.min(250, Math.max(0, now - this.lastTick)); this.lastTick = now;
    this.updateMovement(now);
    const environment = this.environment(now);
    const snapshot = this.behavior.update(environment);
    const preparingSleep = this.behavior.shouldRest(now, this.lastActivity);
    const needsHome = snapshot.state === 'YAWN' && preparingSleep && !environment.homeSafe;
    const manualExpired = this.manualAt !== undefined && now - this.lastActivity > this.config.manualReturnMs;
    if (needsHome || (!preparingSleep && (manualExpired || (this.roaming && now >= this.nextMove && !asleep(snapshot.state) && snapshot.state !== 'WAKE_UP')))) this.chooseMovement(now, needsHome);
    if (this.lightning.active && !this.relocation) this.lightning.update(now);
    if (delta || this.lastDraw === -Infinity) this.draw(now);
    this.schedule();
  };
  private draw(now: number, force = false): void {
    const snapshot = this.behavior.snapshot;
    const interval = this.animation.renderInterval(snapshot.state, this.reduced || this.calm, this.mobile);
    if (!force && snapshot.state === this.lastState && now - this.lastDraw < interval) return;
    this.lastDraw = now;
    if (snapshot.state !== this.lastState) {
      this.lastState = snapshot.state; this.options.host.setAttribute('data-behavior', snapshot.state); this.options.stateChanged(snapshot.state);
    }
    const landing = now - this.landingAt;
    const offsetY = landing >= 0 && landing < 600 ? Math.min(3, Math.max(-2, landingOffset(landing, this.landingVelocity))) : undefined;
    this.renderer.render(this.animation.sample(snapshot, now, { gaze: now < this.pointerUntil ? this.gaze : undefined, lean: this.dragging ? now - this.dragMotionAt < 240 ? this.lean : 0 : undefined, facing: this.facing, offsetY, glitch: this.allowsGlitch && this.options.glitch(), static: this.reduced || this.calm }));
  }
  private schedule(): void {
    if (!this.running || this.destroyed || this.suspended || this.reduced || this.calm || this.raf !== undefined || this.timer !== undefined) return;
    const interval = this.dragging || this.relocation ? 0 : asleep(this.state) ? 280 : this.mobile ? 130 : 90;
    const request = () => { this.timer = undefined; if (!this.destroyed && !this.suspended) this.raf = window.requestAnimationFrame(this.tick); };
    if (interval) this.timer = setTimeout(request, interval); else request();
  }
  private cancelFrame(): void {
    if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined;
    if (this.raf !== undefined) window.cancelAnimationFrame(this.raf); this.raf = undefined;
  }
}

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CharacterController } from '../apps/widget/src/companion/CharacterController.js';
import { SafeZoneManager } from '../apps/widget/src/companion/SafeZoneManager.js';
import type { BehaviorConfig, CharacterState, Point, Rect } from '../apps/widget/src/companion/types.js';

const disposals: Array<() => void> = [];
afterEach(() => disposals.splice(0).reverse().forEach(dispose => dispose()));

/** A bounded manual clock controls BOTH timeout and RAF; no wall-clock sleeps/network. */
function harness(config: Partial<BehaviorConfig> = {}, initial?: Point, forbidden: Rect[] = [], random: () => number = () => 0) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"><button id="launcher">KARI</button><canvas id="sprite"></canvas></div></body></html>', { pretendToBeVisual: true, url: 'https://host.example' });
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const originalSetTimeout = globalThis.setTimeout; const originalClearTimeout = globalThis.clearTimeout;
  const originalRandom = Math.random;
  let now = 0; let nextId = 1; let spriteDraws = 0; let effectDraws = 0; let glitchReads = 0; let blocked = false;
  let placementAllowed = (_rect: Rect) => true;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const frames = new Map<number, FrameRequestCallback>();
  const host = dom.window.document.getElementById('host') as HTMLElement;
  const canvas = dom.window.document.getElementById('sprite') as HTMLCanvasElement;
  const viewport: Rect = { left: 0, top: 0, width: 1200, height: 900 };
  const size = { width: 96, height: 144 };
  let position: Point = initial ? { ...initial } : { x: 1092, y: 744 };
  const moves: Point[] = []; const states: CharacterState[] = [];

  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true, writable: true });
  globalThis.setTimeout = ((callback: () => void, delay = 0) => { const id = nextId++; timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(Number(id)); }) as unknown as typeof clearTimeout;
  dom.window.requestAnimationFrame = callback => { const id = nextId++; frames.set(id, callback); return id; };
  dom.window.cancelAnimationFrame = id => { frames.delete(id); };
  Math.random = random;
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { value: function(this: HTMLCanvasElement) {
    const sprite = this.id === 'sprite';
    return {
      imageSmoothingEnabled: false, globalAlpha: 1, fillStyle: '',
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: () => { if (sprite) spriteDraws++; },
      clearRect() {}, fillRect: () => { if (!sprite) effectDraws++; },
    };
  } });

  const controller = new CharacterController({
    canvas, host,
    position: () => ({ left: position.x, top: position.y, ...size }),
    move: point => { position = { ...point }; moves.push({ ...point }); },
    viewport: () => ({ ...viewport }), exclusions: () => forbidden,
    canPlace: rect => placementAllowed(rect),
    interactionBlocked: () => blocked,
    glitch: () => { glitchReads++; return true; },
    stateChanged: state => states.push(state),
  }, { decisionMs: 1000, sleepAfterMs: 1_000_000, sleepMinMs: 60_000, sleepMaxMs: 60_000, moveMinMs: 1_000_000, moveMaxMs: 1_000_000, manualReturnMs: 2000, lightningChance: 0, ...config });
  const preferences = { suspended: false, reduced: false, calm: false, mobile: false, pinned: false, roaming: true, open: false };
  controller.start();

  const advance = (duration: number) => {
    const end = now + duration;
    let steps = 0;
    while (now < end) {
      if (++steps > 100_000) throw new Error('Unbounded character clock loop');
      now = Math.min(end, now + 16);
      let flushed = 0;
      while (true) {
        const due = [...timers.entries()].find(([, timer]) => timer.at <= now);
        if (!due) break;
        if (++flushed > 1000) throw new Error('Unbounded zero-delay timeout chain');
        timers.delete(due[0]); due[1].callback();
      }
      const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(now));
    }
  };
  const until = (predicate: () => boolean, budget = 15_000) => {
    const end = now + budget;
    while (!predicate() && now < end) advance(16);
    assert.ok(predicate(), `Condition not reached at${now}ms; character=${controller.state},phase=${host.getAttribute('data-relocation-phase')}`);
  };
  const delayedFrame = (duration: number) => {
    now += duration;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(now));
  };
  const dispose = () => {
    controller.destroy(); dom.window.close();
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; Math.random = originalRandom;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else delete (globalThis as any).window;
    if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance);
  };
  disposals.push(dispose);
  return {
    dom, controller, host, canvas, viewport, size, moves, states, advance, until, delayedFrame,
    now: () => now, position: () => ({ ...position }), place: (point: Point) => { position = { ...point }; },
    blocked: (value: boolean) => { blocked = value; },
    allowPlacement: (check: (rect: Rect) => boolean) => { placementAllowed = check; },
    pending: () => timers.size + frames.size,
    spriteDraws: () => spriteDraws, effectDraws: () => effectDraws, glitchReads: () => glitchReads,
    lightningCount: () => dom.window.document.querySelectorAll('[data-kari-lightning]').length,
    preferences: (value: Partial<typeof preferences>) => { Object.assign(preferences, value); controller.preferences(preferences); },
  };
}

test('autonomous idle progresses through yawn into sleep and wakes fully before returning to attention', () => {
  const h = harness({ sleepAfterMs: 1000 });
  h.preferences({ roaming: false });
  h.until(() => h.controller.state === 'SLEEP', 12_000);
  assert.ok(h.states.includes('YAWN')); assert.ok(h.states.includes('SLEEP'));
  assert.equal(h.states.some(state => String(state) === 'SIT'), false);
  const wait = h.controller.wake();
  assert.equal(h.controller.state, 'WAKE_UP'); assert.ok(wait >= 1000);
  h.advance(400); assert.equal(h.controller.state, 'WAKE_UP');
  assert.ok(h.controller.wake() < wait, 'Repeated wake does not restart the animation');
  h.advance(850);
  assert.equal(h.controller.state, 'IDLE');
  assert.equal(h.host.getAttribute('data-behavior'), 'IDLE');
  assert.equal(h.lightningCount(), 0);
});

test('frequent roaming visits varied safe positions while idle chat stays open', () => {
  const h = harness({ moveMinMs: 6000, moveMaxMs: 6000 });
  h.preferences({ open: true });
  h.advance(27_000);
  assert.ok(h.moves.length >= 3, 'An open but idle bubble must not freeze roaming');
  assert.ok(new Set(h.moves.map(point => `${point.x},${point.y}`)).size >= 3, 'The mascot explores rather than ping-ponging between two stops');
  const zones = new SafeZoneManager(h.viewport, h.size);
  for (const point of h.moves) assert.ok(zones.isSafe(point));
  assert.equal(h.states.some(state => state === 'WALK' || state === 'RUN' || state === 'DANCE'), false);
});

test('error and an expired speaking reaction cannot leave roaming permanently stuck', () => {
  const h = harness({ moveMinMs: 6000, moveMaxMs: 6000 });
  h.controller.conversation('error', 'Belum bisa terhubung.'); h.advance(8000);
  assert.ok(h.moves.length >= 1, 'A failed request does not lock movement forever');
  const count = h.moves.length;
  h.controller.conversation('talk', 'Hai lagi!'); h.advance(12_000);
  assert.ok(h.moves.length > count, 'Speaking has a finite local animation even if an old UI timer was cancelled');
});

test('blocked geometry retries soon and rapid roaming yields to the bedtime sequence', () => {
  const forbidden = [{ left: 0, top: 0, width: 1200, height: 900 }];
  const h = harness({ moveMinMs: 1000, moveMaxMs: 1000 }, undefined, forbidden);
  h.advance(4000); assert.equal(h.moves.length, 0);
  forbidden.splice(0);
  h.until(() => h.moves.length > 0, 3000);
  assert.ok(new SafeZoneManager(h.viewport, h.size).isSafe(h.position()));
});

test('rapid roaming returns home then permits sleep without repeatedly interrupting yawn', () => {
  const h = harness({ sleepAfterMs: 1000, moveMinMs: 1000, moveMaxMs: 1000 }, { x: 1092, y: 300 });
  h.until(() => h.controller.state === 'SLEEP', 15_000);
  const count = h.moves.length;
  assert.ok(count >= 1, 'Sleep first relocates to a safe bottom position');
  h.advance(10_000); assert.equal(h.moves.length, count, 'Sleeping stays put instead of continuing to blink');
});

test('horizontal autonomous blink commits once, paints a line and never walks or runs', () => {
  const exclusions = [{ left: 990, top: 480, width: 120, height: 80 }];
  const h = harness({ moveMinMs: 1000, moveMaxMs: 1000, lightningChance: 1 }, undefined, exclusions);
  h.until(() => h.host.getAttribute('data-relocation-phase') === 'prepare', 3000);
  assert.equal(h.lightningCount(), 1);
  assert.equal(h.moves.length, 0, 'Prepare keeps the original position');
  h.until(() => h.host.getAttribute('data-relocation-phase') === 'hidden', 1000);
  assert.ok(h.effectDraws() > 0);
  h.until(() => !h.host.hasAttribute('data-moving'), 3000);
  assert.equal(h.host.hasAttribute('data-relocation-phase'), false);
  const zone = new SafeZoneManager(h.viewport, h.size, exclusions);
  assert.equal(h.moves.length, 1, 'Teleport has one destination commit, not interpolated walking positions');
  assert.equal(h.moves[0].y, 744);
  assert.equal(h.states.some(state => state === 'WALK' || state === 'RUN'), false);
  for (const point of h.moves) { assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y)); assert.ok(zone.isSafe(point), JSON.stringify(point)); }
  h.controller.preferences({ suspended: false, reduced: false, calm: false, mobile: false, pinned: true, roaming: false, open: false });
  h.advance(1500);
  assert.equal(h.lightningCount(), 0);
});

test('random roaming explores fresh inset coordinates and several edges without a near-position loop', () => {
  let seed = 354;
  const h = harness({ moveMinMs: 6000, moveMaxMs: 6000 }, undefined, [], () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; });
  h.advance(90_000);
  assert.ok(h.moves.length >= 12);
  assert.equal(new Set(h.moves.map(point => `${point.x},${point.y}`)).size, h.moves.length);
  assert.ok(new Set(h.moves.map(point => point.x)).size >= 8);
  assert.ok(new Set(h.moves.map(point => point.y)).size >= 6);
  assert.ok(h.moves.some(point => point.x < 130));
  assert.ok(h.moves.some(point => point.x > 980));
  assert.ok(h.moves.some(point => point.y > 730 && point.x > 180 && point.x < 980));
  const zones = new SafeZoneManager(h.viewport, h.size);
  for (let index = 0; index < h.moves.length; index++) {
    const point = h.moves[index]!;
    assert.ok(zones.isSafe(point));
    assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y));
    for (const previous of h.moves.slice(Math.max(0, index - 7), index)) assert.ok(Math.hypot(point.x - previous.x, point.y - previous.y) >= 120, 'Prefer an unvisited area when broad safe space exists');
  }
});

test('a generic explicit blink chooses varied coordinates even while autonomous movement is pinned', () => {
  let seed = 939;
  const h = harness({}, undefined, [], () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; });
  h.preferences({ pinned: true, roaming: false });
  for (let index = 0; index < 10; index++) {
    assert.equal(h.controller.relocateRandom(), true);
    h.until(() => !h.host.hasAttribute('data-moving'), 1000);
  }
  assert.equal(new Set(h.moves.map(point => `${point.x},${point.y}`)).size, 10);
  assert.ok(new Set(h.moves.map(point => point.y)).size > 4);
});

test('random blink falls back to nearby familiar stops when the open bubble rejects fresh space', () => {
  const h = harness();
  const origin = h.position(); let checks = 0;
  h.allowPlacement(rect => { checks++; return Math.hypot(rect.left - origin.x, rect.top - origin.y) <= 90; });
  assert.equal(h.controller.relocateRandom(), true);
  assert.ok(checks <= 12, 'Fresh plus fallback placement checks remain bounded');
  h.until(() => !h.host.hasAttribute('data-moving'), 1000);
  assert.equal(h.moves.length, 1);
  assert.ok(Math.hypot(h.position().x - origin.x, h.position().y - origin.y) <= 90);
});

test('blink relocation preserves an active long expression, while typing can still interrupt it', () => {
  const h = harness();
  h.controller.behavior.force('HAPPY', h.now()); h.controller.redraw();
  const expression = h.controller.behavior.snapshot;
  assert.equal(h.controller.relocate({ x: 12, y: 744 }, true), true);
  h.until(() => h.host.getAttribute('data-relocation-phase') === 'arrive');
  assert.equal(h.controller.state, 'HAPPY');
  assert.equal(h.controller.behavior.snapshot.startedAt, expression.startedAt);
  h.advance(4000); assert.equal(h.controller.state, 'HAPPY');
  h.controller.activity(true); assert.equal(h.controller.state, 'LISTEN');
});

test('typing interrupts travel and clears lightning phase/canvas so the character stays visible', () => {
  const h = harness({ moveMinMs: 1000, moveMaxMs: 1000, lightningChance: 1 });
  h.until(() => h.host.getAttribute('data-relocation-phase') === 'hidden', 4000);
  assert.equal(h.lightningCount(), 1);
  h.controller.activity(true);
  assert.equal(h.controller.state, 'LISTEN');
  assert.equal(h.host.hasAttribute('data-moving'), false);
  assert.equal(h.host.hasAttribute('data-lightning'), false);
  assert.equal(h.host.hasAttribute('data-relocation-phase'), false);
  assert.equal(h.lightningCount(), 0);
  const position = h.position(); h.advance(1200);
  assert.deepEqual(h.position(), position, 'Typing never resumes an interrupted move automatically');
});

test('drag interrupts special travel; release lands without glitch reads or relocation effects', () => {
  const h = harness({ moveMinMs: 1000, moveMaxMs: 1000, lightningChance: 1 });
  h.until(() => h.host.getAttribute('data-relocation-phase') === 'hidden', 4000);
  h.controller.dragStart();
  assert.equal(h.controller.state, 'DRAGGED');
  assert.equal(h.controller.allowsGlitch, false);
  assert.equal(h.host.hasAttribute('data-relocation-phase'), false); assert.equal(h.lightningCount(), 0);
  h.controller.dragVelocity({ x: 170, y: 260 }); h.advance(64);
  const reads = h.glitchReads();
  h.controller.dragEnd(false, 260);
  assert.equal(h.controller.state, 'LANDED'); assert.equal(h.controller.allowsGlitch, false);
  h.preferences({ pinned: true }); h.advance(500);
  assert.equal(h.controller.state, 'LANDED'); assert.equal(h.glitchReads(), reads);
  assert.equal(h.lightningCount(), 0); assert.equal(h.host.hasAttribute('data-relocation-phase'), false);
  h.advance(1400);
  assert.equal(h.controller.state, 'IDLE');
  assert.equal(h.controller.allowsGlitch, false, 'Landing effect suppression outlasts the bounce');
  assert.equal(h.glitchReads(), reads);
});

test('reduced, hidden and destroyed controllers stop drawing and release all timeout/RAF work', () => {
  const h = harness();
  h.advance(300); assert.ok(h.pending() > 0);
  h.preferences({ reduced: true });
  const reducedDraws = h.spriteDraws(); assert.equal(h.pending(), 0);
  h.advance(3000); assert.equal(h.spriteDraws(), reducedDraws);
  h.preferences({ reduced: false }); h.advance(300);
  assert.ok(h.spriteDraws() > reducedDraws); assert.ok(h.pending() > 0);
  h.preferences({ suspended: true });
  const hiddenDraws = h.spriteDraws(); assert.equal(h.pending(), 0);
  h.advance(3000); assert.equal(h.spriteDraws(), hiddenDraws);
  h.preferences({ suspended: false }); h.advance(300);
  assert.ok(h.spriteDraws() > hiddenDraws);
  h.controller.destroy();
  const finalDraws = h.spriteDraws();
  assert.equal(h.pending(), 0); assert.equal(h.lightningCount(), 0);
  assert.equal(h.host.hasAttribute('data-behavior'), false);
  assert.equal(h.host.hasAttribute('data-relocation-phase'), false);
  h.advance(120_000); assert.equal(h.spriteDraws(), finalDraws); assert.equal(h.pending(), 0);
});

test('manual center placement returns safely while launcher focus does not count as active typing', () => {
  const h = harness({ manualReturnMs: 2000, lightningChance: 1 });
  h.place({ x: 550, y: 350 });
  h.controller.dragStart(); h.controller.dragEnd(false);
  const launcher = h.dom.window.document.getElementById('launcher') as HTMLButtonElement;
  launcher.focus(); assert.equal(h.dom.window.document.activeElement, launcher);
  h.blocked(false);
  h.until(() => h.moves.length > 0, 8000);
  h.until(() => !h.host.hasAttribute('data-moving'), 12_000);
  assert.ok(new SafeZoneManager(h.viewport, h.size).isSafe(h.position()), 'Manual central drop leaves central content through a safe escape route');
  assert.equal(h.lightningCount(), 0, 'Escape from manual center placement does not use special lightning');
  assert.equal(h.host.hasAttribute('data-relocation-phase'), false);
});

test('vertical and diagonal commanded blinks have no electrical line, even with the bubble pinned open', () => {
  const h = harness(); h.preferences({ pinned: true, open: true });
  for (const target of [{ x: 1092, y: 12 }, { x: 12, y: 744 }]) {
    const count = h.moves.length;
    assert.equal(h.controller.relocate(target, true), true);
    assert.equal(h.host.getAttribute('data-relocation-phase'), 'prepare');
    assert.equal(h.lightningCount(), 0);
    h.advance(144); assert.equal(h.host.getAttribute('data-relocation-phase'), 'hidden');
    assert.equal(h.moves.length, count, 'KARI vanishes at the origin before committing');
    h.advance(200);
    assert.deepEqual(h.position(), target); assert.equal(h.moves.length, count + 1);
    h.advance(400); assert.equal(h.host.hasAttribute('data-relocation-phase'), false);
  }
  assert.equal(h.controller.relocate({ x: 500, y: 350 }, true), false, 'Unsafe central destination is denied');
});

test('reduced commands move instantly; cancellation before and after commit always restores visibility', () => {
  const h = harness(); h.preferences({ reduced: true });
  assert.equal(h.controller.relocate({ x: 12, y: 744 }, true), true);
  assert.deepEqual(h.position(), { x: 12, y: 744 });
  assert.equal(h.lightningCount(), 0); assert.equal(h.host.hasAttribute('data-relocation-phase'), false);
  h.preferences({ reduced: false });
  assert.equal(h.controller.relocate({ x: 1092, y: 744 }, true), true);
  h.controller.activity(true); h.advance(500);
  assert.deepEqual(h.position(), { x: 12, y: 744 }, 'Before commit cancellation retains the origin');
  assert.equal(h.lightningCount(), 0); assert.equal(h.host.hasAttribute('data-relocation-phase'), false);
  assert.equal(h.controller.relocate({ x: 1092, y: 744 }, true), true);
  h.until(() => h.host.getAttribute('data-relocation-phase') === 'arrive'); h.preferences({ suspended: true }); h.advance(500);
  assert.deepEqual(h.position(), { x: 1092, y: 744 }, 'After commit cancellation retains the destination');
  assert.equal(h.lightningCount(), 0); assert.equal(h.host.hasAttribute('data-relocation-phase'), false);
});

test('a delayed frame cannot skip disappearance or commit the destination before a hidden frame', () => {
  const h = harness();
  const origin = h.position(), target = { x: 12, y: 744 };
  assert.equal(h.controller.relocate(target, true), true);
  h.delayedFrame(1000);
  assert.equal(h.host.getAttribute('data-relocation-phase'), 'hidden');
  assert.deepEqual(h.position(), origin); assert.equal(h.moves.length, 0);
  h.advance(100); assert.equal(h.host.getAttribute('data-relocation-phase'), 'hidden');
  h.advance(120); assert.equal(h.host.getAttribute('data-relocation-phase'), 'arrive');
  assert.deepEqual(h.position(), target); assert.equal(h.moves.length, 1);
  h.delayedFrame(1000);
  assert.equal(h.host.hasAttribute('data-relocation-phase'), false); assert.equal(h.lightningCount(), 0);
});

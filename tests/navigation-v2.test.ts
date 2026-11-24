import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { SafeZoneManager } from '../apps/widget/src/companion/SafeZoneManager.js';
import { MovementController, landingOffset } from '../apps/widget/src/companion/MovementController.js';
import { LightningEffect, BLINK_TIMING } from '../apps/widget/src/companion/LightningEffect.js';
import type { Point, Rect } from '../apps/widget/src/companion/types.js';

const viewport: Rect = { left: 0, top: 0, width: 1200, height: 900 };
const size = { width: 80, height: 100 };
function everyPoint(route: Point[], check: (point: Point) => void) {
  for (let segment = 0; segment < route.length - 1; segment++) {
    const a = route[segment]!, b = route[segment + 1]!;
    const steps = Math.ceil(Math.hypot(a.x - b.x, a.y - b.y));
    for (let index = 0; index <= steps; index++) check({ x: a.x + (b.x - a.x) * index / steps, y: a.y + (b.y - a.y) * index / steps });
  }
}

test('safe zones test the entire sprite against center, controls and viewport', () => {
  const zones = new SafeZoneManager(viewport, size, [{ left: 1080, top: 700, width: 120, height: 50 }]);
  assert.equal(zones.isSafe({ x: 1100, y: 780 }), true);
  assert.equal(zones.isSafe({ x: 1060, y: 680 }), false);
  assert.equal(zones.isSafe({ x: 200, y: 140 }), false); // sprite overlaps center even if top-left is outside
  assert.equal(zones.isSafe({ x: -1, y: 0 }), false);
  assert.equal(zones.isSafe({ x: NaN, y: 30 }), false);
  assert.equal(zones.isPeripheral({ x: 20, y: 300 }), true);
});

test('route travels around center and explicit obstacles, never through them', () => {
  const zones = new SafeZoneManager({ ...viewport, height: 1200 }, size, [{ left: 500, top: 1050, width: 120, height: 100 }]);
  const from = { x: 1090, y: 1080 }, to = { x: 20, y: 1080 };
  const route = zones.route(from, to);
  assert.ok(route && route.length > 2);
  assert.deepEqual(route[0], from); assert.deepEqual(route.at(-1), to);
  everyPoint(route, point => assert.equal(zones.isSafe(point), true, JSON.stringify(point)));
  assert.equal(zones.route(from, { x: 550, y: 400 }), null);
});

test('peripheral destinations include nearby useful movements, not only distant corners', () => {
  const zones = new SafeZoneManager(viewport, size);
  const from = { x: 1100, y: 780 };
  const destinations = zones.destinations(from);
  assert.ok(destinations.length > 4);
  assert.ok(destinations.some(point => Math.hypot(point.x - from.x, point.y - from.y) < 150));
  assert.ok(destinations.every(point => zones.isSafe(point)));
});

test('a narrow mobile bottom strip still provides several safe blink stops', () => {
  const zones = new SafeZoneManager({ left: 0, top: 0, width: 390, height: 844 }, { width: 104, height: 100 }, [{ left: 132, top: 700, width: 258, height: 144 }]);
  const stops = zones.destinations({ x: 12, y: 732 });
  assert.ok(stops.filter(point => point.x === 12 && point.y < 732).length >= 2, 'Smaller useful steps prevent a cramped safe edge looking stuck');
  assert.ok(stops.every(point => zones.isSafe(point)));
});

function seededCoordinates(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

test('seeded perimeter strata produce fresh inset coordinates instead of only fixed edges', () => {
  const zones = new SafeZoneManager(viewport, size);
  const from = { x: 1100, y: 780 };
  const first = zones.destinations(from, seededCoordinates(17));
  assert.deepEqual(zones.destinations(from, seededCoordinates(17)), first, 'injected seed makes the proposal set reproducible');
  assert.notDeepEqual(zones.destinations(from, seededCoordinates(18)), first, 'a fresh draw changes actual destinations');
  const insets = first.filter(point => point.x > 12 && point.x < 1108 && point.y > 12 && point.y < 788 && point.x !== from.x && point.y !== from.y);
  assert.ok(insets.length >= 12, 'whole-box-safe points are distributed inside perimeter strips, not just on four edges');
  assert.ok(first.every(point => Number.isInteger(point.x) && Number.isInteger(point.y) && zones.isSafe(point)));
  assert.ok(first.some(point => point.y === from.y && Math.abs(point.x - from.x) >= 24), 'same-height proposals retain horizontal effect opportunities');
  assert.ok(first.length <= 116);
});

test('fractional viewport offsets round inward and every proposed whole box respects exclusions', () => {
  const shifted = { left: 37.5, top: 91.25, width: 800.5, height: 600.5 };
  const sprite = { width: 73.5, height: 99.25 };
  const controls = [{ left: 730, top: 540, width: 110, height: 150 }, { left: 40, top: 230, width: 70, height: 80 }];
  const zones = new SafeZoneManager(shifted, sprite, controls);
  const from = { x: 750, y: 580 };
  const points = zones.destinations(from, seededCoordinates(25));
  assert.ok(points.length > 8);
  for (const point of points) {
    assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y));
    assert.ok(point.x >= shifted.left + 12 && point.y >= shifted.top + 12);
    assert.ok(point.x + sprite.width <= shifted.left + shifted.width - 12);
    assert.ok(point.y + sprite.height <= shifted.top + shifted.height - 12);
    assert.ok(Math.hypot(point.x - from.x, point.y - from.y) >= 24);
    assert.equal(zones.isSafe(point), true, JSON.stringify(point));
  }
});

test('bounded sampling tolerates invalid RNG values and blocked or cramped mobile geometry', () => {
  for (const value of [NaN, Infinity, -4, 9]) {
    let draws = 0;
    const zones = new SafeZoneManager(viewport, size);
    const points = zones.destinations({ x: 1100, y: 780 }, () => { draws++; return value; });
    assert.ok(draws <= 136 && points.length <= 116, 'sampling is hard bounded without repeated retries');
    assert.ok(points.every(point => Number.isInteger(point.x) && Number.isInteger(point.y) && zones.isSafe(point)));
  }
  const mobile = new SafeZoneManager({ left: 0, top: 0, width: 390, height: 844 }, { width: 104, height: 100 }, [{ left: 132, top: 700, width: 258, height: 144 }]);
  const narrowStops = mobile.destinations({ x: 12, y: 732 }, () => .999);
  assert.ok(narrowStops.some(point => point.x === 12 && point.y === 708));
  assert.ok(narrowStops.some(point => point.x === 12 && point.y === 700), '24/32px deterministic fallbacks survive poor random draws');
  const blocked = new SafeZoneManager(viewport, size, [{ left: 0, top: 0, width: 1200, height: 900 }]);
  assert.deepEqual(blocked.destinations({ x: 1100, y: 780 }, seededCoordinates(1)), []);
  const cramped = new SafeZoneManager({ left: 0, top: 0, width: 200, height: 200 }, { width: 126, height: 146 });
  assert.deepEqual(cramped.destinations({ x: 20, y: 20 }, seededCoordinates(1)), []);
});

test('small/blocked viewport returns no route; resize recomputes geometry', () => {
  const zones = new SafeZoneManager(viewport, size, [{ left: 1060, top: 0, width: 140, height: 900 }]);
  assert.equal(zones.route({ x: 1090, y: 780 }, { x: 20, y: 780 }), null);
  zones.update({ left: 0, top: 0, width: 200, height: 200 }, { width: 126, height: 146 }, []);
  assert.deepEqual(zones.destinations({ x: 20, y: 20 }), []);
});

test('manual center escape permits only first exit and never ignores controls', () => {
  const zones = new SafeZoneManager(viewport, size);
  const from = { x: 550, y: 400 }, to = { x: 20, y: 780 };
  assert.equal(zones.route(from, to), null);
  const escape = zones.route(from, to, { escape: true });
  assert.ok(escape && escape.length >= 2);
  for (let index = 1; index < escape.length; index++) assert.equal(zones.isSafe(escape[index]!), true);
  const occupied = new SafeZoneManager(viewport, size, [{ left: 540, top: 390, width: 100, height: 140 }]);
  assert.equal(occupied.route(from, to, { escape: true }), null);
});

test('movement follows supplied polyline with integer positions and acceleration/deceleration', () => {
  const controller = new MovementController();
  const route = [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 120 }];
  controller.start(route, 1000, 100);
  assert.equal(controller.active, true);
  assert.deepEqual(controller.update(1000).position, route[0]);
  assert.ok(controller.update(1200).position.x < 20, 'ease-in starts gently');
  const middle = controller.update(2000);
  assert.ok(middle.position.x === 110 && middle.position.y <= 22, 'does not cut diagonal corner');
  for (let time = 1000; time <= 4000; time += 33) {
    const update = controller.update(time);
    assert.equal(Number.isInteger(update.position.x) && Number.isInteger(update.position.y), true);
    assert.ok(update.position.y === 20 || update.position.x === 110);
  }
  const end = controller.update(5000);
  assert.equal(end.done, true); assert.deepEqual(end.position, route[2]); assert.equal(controller.active, false);
});

test('cancel preserves position, facing follows movement and landing is bounded', () => {
  const controller = new MovementController();
  controller.start([{ x: 120, y: 40 }, { x: 20, y: 40 }], 0, 100);
  assert.equal(controller.update(700).facing, -1);
  const position = controller.update(750).position;
  assert.ok(controller.remainingRoute.length >= 2);
  controller.cancel();
  assert.equal(controller.active, false); assert.deepEqual(controller.update(1000).position, position);
  assert.deepEqual(controller.remainingRoute, []);
  for (let elapsed = 0; elapsed <= 500; elapsed++) assert.ok(Math.abs(landingOffset(elapsed, 900)) <= 10);
  assert.equal(landingOffset(480), 0); assert.equal(landingOffset(-1), 0);
});

test('horizontal blink bolt uses a narrow fixed canvas, fades quickly and rejects vertical or bent paths', () => {
  const dom = new JSDOM('<body><div style="transform:translate(30px,30px)"></div></body>');
  const calls: { x: number; y: number; width: number; height: number }[] = [];
  let clears = 0;
  const context = { imageSmoothingEnabled: true, globalAlpha: 1, fillStyle: '', clearRect: () => { clears++; }, fillRect: (x: number, y: number, width: number, height: number) => { calls.push({ x, y, width, height }); } };
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { value: () => context });
  const effect = new LightningEffect(dom.window.document);
  effect.start([{ x: 30, y: 50 }, { x: 400, y: 50 }], { left: 10, top: 20, width: 500, height: 500 }, 1000);
  const canvas = dom.window.document.querySelector<HTMLCanvasElement>('canvas[data-kari-lightning]')!;
  assert.equal(effect.active, true); assert.equal(canvas.parentElement, dom.window.document.body);
  assert.equal(canvas.style.position, 'fixed'); assert.equal(canvas.style.pointerEvents, 'none');
  assert.ok(canvas.width < 400 && canvas.height <= 24, 'A short bolt does not allocate a full viewport buffer'); assert.equal(context.imageSmoothingEnabled, false);
  calls.length = 0; effect.update(1200);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.y < 24 && call.y >= 0), 'Electrical line stays within its narrow horizontal band');
  assert.ok(calls.every(call => Number.isInteger(call.x) && Number.isInteger(call.y) && call.width === 2 && call.height === 1));
  effect.update(1500);
  assert.equal(effect.active, false); assert.equal(dom.window.document.querySelector('canvas'), null);
  assert.ok(clears > 1);
  effect.start([{ x: 30, y: 50 }, { x: 30, y: 400 }], viewport, 2000); assert.equal(effect.active, false);
  effect.start([{ x: 30, y: 50 }, { x: 400, y: 50 }, { x: 400, y: 450 }], viewport, 2000); assert.equal(effect.active, false);
  effect.start([{ x: 20, y: 20 }, { x: 50, y: 20 }], viewport, 3000);
  effect.cancel(); assert.equal(dom.window.document.querySelector('canvas'), null);
  effect.destroy(); effect.start([{ x: 20, y: 20 }, { x: 50, y: 20 }], viewport, 4000); assert.equal(effect.active, false);
  dom.window.close();
});

function lightningHarness() {
  const dom = new JSDOM('<body></body>');
  const pixels: Array<{ x: number; y: number; width: number; height: number; color: string; alpha: number }> = [];
  let clears = 0;
  const context = {
    imageSmoothingEnabled: true, globalAlpha: 1, fillStyle: '',
    clearRect() { clears++; },
    fillRect(x: number, y: number, width: number, height: number) { pixels.push({ x, y, width, height, color: context.fillStyle, alpha: context.globalAlpha }); },
  };
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', { value: () => context });
  return { dom, pixels, context, clears: () => clears, effect: new LightningEffect(dom.window.document) };
}

test('horizontal activations vary irregular geometry even when host Math.random is constant', t => {
  const h = lightningHarness(), originalRandom = Math.random;
  Math.random = () => 0;
  t.after(() => { Math.random = originalRandom; h.effect.destroy(); h.dom.window.close(); });
  const route = [{ x: 30, y: 50 }, { x: 400, y: 50 }];
  const signatures = new Set<string>();
  for (let activation = 0; activation < 5; activation++) {
    const start = activation * 1000;
    h.effect.start(route, viewport, start);
    h.pixels.length = 0; h.effect.update(start + 200);
    signatures.add(JSON.stringify(h.pixels.map(({ x, y, color }) => [x, y, color])));
    assert.ok(h.pixels.some(pixel => pixel.color === '#35fff0'), 'bright cyan core stays present');
    assert.ok(h.pixels.some(pixel => pixel.color === '#ff007b'), 'magenta echoes provide color separation');
    const coreY = new Set(h.pixels.filter(pixel => pixel.color === '#35fff0').map(pixel => pixel.y));
    assert.ok(coreY.size > 3, 'main geometry has coherent irregular kinks rather than one straight stripe');
    assert.equal(h.dom.window.document.querySelectorAll('[data-kari-lightning]').length, 1, 'restarting replaces the prior band');
  }
  assert.equal(signatures.size, 5, 'a sequence salt keeps repeated activations from sharing a fixed sawtooth');
});

test('bolt geometry is deterministic per phase, draw work is bounded, and redraws are capped', t => {
  const h = lightningHarness();
  t.after(() => { h.effect.destroy(); h.dom.window.close(); });
  h.effect.start([{ x: 30, y: 50 }, { x: 400, y: 50 }], viewport, 1000);
  h.pixels.length = 0; h.effect.update(1200);
  const frame = [...h.pixels], clears = h.clears();
  assert.ok(frame.length > 100 && frame.length < 2500, 'cached paths bound per-frame pixel work');
  const canvas = h.dom.window.document.querySelector('canvas')!;
  assert.ok(canvas.height <= 22 && canvas.width < 400);
  assert.ok(frame.every(pixel => pixel.x >= 0 && pixel.x + pixel.width <= canvas.width && pixel.y >= 0 && pixel.y + pixel.height <= canvas.height));
  assert.ok(frame.every(pixel => Number.isInteger(pixel.x) && Number.isInteger(pixel.y) && pixel.width === 2 && pixel.height === 1));
  assert.ok(frame.every(pixel => ['#35fff0', '#35ff99', '#ff007b'].includes(pixel.color)), 'never introduces a white flash');
  for (let time = 1201; time <= 1232; time++) h.effect.update(time);
  assert.equal(h.clears(), clears, 'repeated coordinator updates cannot redraw more than roughly 30fps');
  assert.deepEqual(h.pixels, frame);
  h.pixels.length = 0; h.effect.update(1234);
  assert.deepEqual(h.pixels, frame, 'same seeded geometry and visual phase produce the same frame without random reroll');
});

test('residual arcs fade and exact lifetime cleanup bypasses the frame cap', t => {
  const h = lightningHarness();
  t.after(() => { h.effect.destroy(); h.dom.window.close(); });
  assert.deepEqual(BLINK_TIMING, { prepare: 120, reveal: 300, total: 500 });
  h.effect.start([{ x: 400, y: 50 }, { x: 30, y: 50 }], viewport, 1000);
  h.pixels.length = 0; h.effect.update(1200);
  const bright = Math.max(...h.pixels.filter(pixel => pixel.color === '#35fff0').map(pixel => pixel.alpha));
  h.pixels.length = 0; h.effect.update(1400);
  assert.ok(h.pixels.length > 0 && h.pixels.every(pixel => pixel.alpha < bright), 'residual discharge fades instead of a constant brightness tail');
  h.effect.update(1499);
  assert.equal(h.effect.active, true);
  h.effect.update(1500);
  assert.equal(h.effect.active, false, 'cleanup still runs one millisecond after a recent repaint');
  assert.equal(h.dom.window.document.querySelector('canvas'), null);
  const draws = h.clears(); h.effect.update(1700); assert.equal(h.clears(), draws);
});

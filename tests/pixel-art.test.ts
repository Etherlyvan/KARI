import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildPixelFrame, PIXEL_PALETTE, PixelKariRenderer, type PixelState } from '../apps/widget/src/pixel-art.js';
import { CHARACTER_STATES, type CompanionPose } from '../apps/widget/src/companion/types.js';
import { SpriteRenderer } from '../apps/widget/src/companion/SpriteRenderer.js';
import { AnimationController } from '../apps/widget/src/companion/AnimationController.js';

const states: PixelState[] = ['idle', 'think', 'talk', 'happy', 'error'];

test('authored pixel frames have bounded dimensions, transparent background and literal palette indices', () => {
  for (const state of states) for (let frame = 0; frame < 16; frame++) for (const blink of [false, true]) for (const lifted of [false, true]) {
    const result = buildPixelFrame({ state, frame, blink, lifted, glitch: frame % 4 === 3 });
    assert.equal(result.width, 48); assert.equal(result.height, 72);
    assert.equal(result.pixels.length, 48 * 72);
    assert.equal(result.palette, PIXEL_PALETTE);
    assert.ok(result.pixels.every(color => Number.isInteger(color) && color >= 0 && color < PIXEL_PALETTE.length));
    assert.equal(result.pixels[0], 0);
    assert.ok(result.pixels.filter(color => color !== 0).length > 700, 'Full character silhouette is present');
    assert.ok(result.pixels.includes(5), 'magenta hair');
    assert.ok(result.pixels.includes(8), 'green face/core');
    assert.ok(result.pixels.includes(3), 'purple body highlights');
  }
});

test('states, blink, separate-part motion and glitch produce visibly different pixels', () => {
  const baseline = buildPixelFrame({ state: 'idle', frame: 0 }).pixels;
  assert.equal(new Set(states.map(state => Buffer.from(buildPixelFrame({ state, frame: 0 }).pixels).toString('base64'))).size, states.length);
  assert.notDeepEqual(buildPixelFrame({ state: 'idle', blink: true }).pixels, baseline);
  assert.notDeepEqual(buildPixelFrame({ state: 'idle', frame: 1 }).pixels, baseline);
  assert.notDeepEqual(buildPixelFrame({ state: 'idle', glitch: true }).pixels, baseline);
  assert.deepEqual(buildPixelFrame({ state: 'idle', frame: 21 }).pixels, buildPixelFrame({ state: 'idle', frame: 5 }).pixels);
  assert.deepEqual(buildPixelFrame({ state: 'idle', frame: -11 }).pixels, buildPixelFrame({ state: 'idle', frame: 5 }).pixels);
  assert.notDeepEqual(buildPixelFrame({ state: 'idle', frame: 5 }).pixels, buildPixelFrame({ state: 'idle', frame: 1 }).pixels, 'Idle has a true16-frame gesture cycle, not4 repeated phases');
});

function region(pixels: Uint8Array, left: number, top: number, width: number, height: number) {
  const result: number[] = [];
  for (let y = top; y < top + height; y++) for (let x = left; x < left + width; x++) result.push(pixels[y * 48 + x]);
  return result;
}

test('idle cycle changes attention, eye expression and compact wave/stretch poses', () => {
  const idle = (frame: number) => buildPixelFrame({ state: 'idle', frame }).pixels;
  assert.ok(new Set(Array.from({ length: 16 }, (_, frame) => Buffer.from(idle(frame)).toString('base64'))).size >= 12, 'Cycle contains distinct visible poses');
  assert.notDeepEqual(region(idle(4), 17, 18, 15, 12), region(idle(0), 17, 18, 15, 12), 'Look-left changes head/face independently of bob phase');
  assert.notDeepEqual(region(idle(8), 18, 20, 12, 5), region(idle(0), 18, 20, 12, 5), 'Wink changes the eyes');
  assert.notDeepEqual(region(idle(9), 31, 22, 8, 15), region(idle(1), 31, 22, 8, 15), 'Compact wave changes the bent arm beside the face');
  assert.notDeepEqual(region(idle(12), 10, 20, 8, 14), region(idle(0), 10, 20, 8, 14), 'Stretch bends the other elbow near the head');
  assert.notDeepEqual(region(idle(12), 22, 34, 5, 6), region(idle(0), 22, 34, 5, 6), 'Core pulse is visible');
});

test('arms remain proportionate: raised hands stay near the head and hanging hands stay beside hips', () => {
  for (const frame of [12, 13]) {
    const stretch = buildPixelFrame({ state: 'idle', frame }).pixels;
    assert.ok(region(stretch, 8, 0, 10, 18).every(color => ![1, 3, 8, 9, 13].includes(color)), 'No elongated left arm/hand above the hair');
    assert.ok(region(stretch, 34, 0, 10, 17).every(color => ![1, 3, 8, 9, 13].includes(color)), 'No elongated right arm/hand above the hair');
    assert.ok(region(stretch, 10, 20, 8, 8).some(color => color === 8 || color === 9), 'Left hand is beside the head');
    assert.ok(region(stretch, 32, 20, 6, 8).some(color => color === 8 || color === 9), 'Right hand is beside the head');
  }
  for (const frame of [9, 10, 11]) {
    const wave = buildPixelFrame({ state: 'idle', frame }).pixels;
    assert.ok(region(wave, 40, 22, 8, 17).every(color => ![1, 3, 13].includes(color)), 'Wave forearm does not stretch to the canvas edge');
    assert.ok(region(wave, 34, 23, 5, 8).some(color => color === 8 || color === 9), 'Wave hand stays close to the shoulder');
  }
  for (let frame = 0; frame < 4; frame++) {
    const lifted = buildPixelFrame({ state: 'idle', frame, lifted: true }).pixels;
    assert.ok(region(lifted, 13, 40, 7, 6).some(color => color === 8), 'Relaxed left hand hangs close to the hips');
    assert.ok(region(lifted, 29, 40, 7, 6).some(color => color === 8), 'Relaxed right hand hangs close to the hips');
    assert.ok(region(lifted, 0, 52, 8, 20).every(color => ![3, 8, 9, 13].includes(color)), 'Left arm never stretches to the canvas edge');
    assert.ok(region(lifted, 43, 52, 5, 20).every(color => ![3, 8, 9, 13].includes(color)), 'Right arm never stretches to the canvas edge');
  }
});

test('lifted pose dangles arms and legs with surprised eyes, independently of glitch', () => {
  const normal = buildPixelFrame({ state: 'idle', frame: 0 }).pixels;
  const lifted = buildPixelFrame({ state: 'idle', frame: 0, lifted: true }).pixels;
  assert.notDeepEqual(region(lifted, 10, 31, 28, 20).map(Boolean), region(normal, 10, 31, 28, 20).map(Boolean));
  assert.notDeepEqual(region(lifted, 16, 48, 15, 23).map(Boolean), region(normal, 16, 48, 15, 23).map(Boolean));
  assert.notDeepEqual(region(lifted, 18, 18, 13, 12), region(normal, 18, 18, 13, 12));
  assert.notDeepEqual(buildPixelFrame({ state: 'idle', lifted: true, blink: true }).pixels, lifted);
  assert.notDeepEqual(buildPixelFrame({ state: 'idle', lifted: true, glitch: true }).pixels, lifted);
});

test('glitch visibly tears several bands and adds colored echoes without white flashes', () => {
  for (let frame = 0; frame < 4; frame++) {
    const normal = buildPixelFrame({ state: 'idle', frame }).pixels;
    const glitch = buildPixelFrame({ state: 'idle', frame, glitch: true }).pixels;
    const changed = glitch.reduce((count, color, index) => count + Number(color !== normal[index]), 0);
    assert.ok(changed >= 100, `Frame${frame} should visibly change silhouette/color, got${changed}`);
    assert.notDeepEqual(region(glitch, 0, 17, 48, 5), region(normal, 0, 17, 48, 5));
    assert.notDeepEqual(region(glitch, 0, 32, 48, 5), region(normal, 0, 32, 48, 5));
    assert.ok(glitch.filter(color => color === 11).length <= normal.filter(color => color === 11).length, 'No white flash introduced');
  }
});

test('renderer never depends on a timer, network or image, and tolerates unavailable canvas', () => {
  let calls = 0;
  const absent = { width: 0, height: 0, getContext() { calls++; return null; } } as unknown as HTMLCanvasElement;
  const renderer = new PixelKariRenderer(absent);
  assert.doesNotThrow(() => renderer.render({ state: 'idle' }));
  assert.equal(absent.width, 48); assert.equal(absent.height, 72); assert.equal(calls, 1);
  const unsupported = { width: 0, height: 0, getContext() { throw new Error('Unsupported'); } } as unknown as HTMLCanvasElement;
  assert.doesNotThrow(() => new PixelKariRenderer(unsupported).render({ state: 'happy', frame: 3 }));
});

test('renderer caches repeated poses but caps cached frame memory', () => {
  let created = 0; let drawn = 0;
  const context = {
    imageSmoothingEnabled: true,
    createImageData(width: number, height: number) { created++; return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData(image: { data: Uint8ClampedArray }, x: number, y: number) { drawn++; assert.equal(image.data.length, 48 * 72 * 4); assert.equal(x, 0); assert.equal(y, 0); },
  };
  const canvas = { width: 0, height: 0, getContext() { return context; } } as unknown as HTMLCanvasElement;
  const renderer = new PixelKariRenderer(canvas);
  renderer.render({ state: 'idle' }); renderer.render({ state: 'idle' });
  assert.equal(created, 1); assert.equal(drawn, 2); assert.equal(context.imageSmoothingEnabled, false);
  renderer.render({ state: 'idle', lifted: true });
  assert.equal(created, 2, 'Lifted and normal pose have different cache keys');
  for (const state of states) for (let frame = 0; frame < 16; frame++) for (const blink of [false, true]) for (const glitch of [false, true]) for (const lifted of [false, true]) renderer.render({ state, frame, blink, glitch, lifted });
  assert.ok((renderer as unknown as { frames: Map<string, unknown> }).frames.size <= 40);
});

test('supported companion behaviors have readable distinct poses within the same tiny palette canvas', () => {
  const signatures = new Set<string>();
  for (const behavior of CHARACTER_STATES) {
    const frame = buildPixelFrame({ state: 'idle', behavior, progress: 0.55, frame: 1 });
    signatures.add(Buffer.from(frame.pixels).toString('base64'));
    assert.equal(frame.pixels.length, 48 * 72);
    assert.ok(frame.pixels.filter(color => color !== 0).length > 600, `${behavior} has a complete character`);
    assert.ok(frame.pixels.every(color => color < PIXEL_PALETTE.length));
    for (const phase of [0, 1, 2, 3]) {
      const varied = buildPixelFrame({ state: 'idle', behavior, progress: phase / 3, frame: phase, gaze: phase === 1 ? -1 : 1, lean: phase === 3 ? -1 : 0, offsetY: phase - 1, facing: phase === 2 ? -1 : 1 });
      assert.equal(varied.pixels.length, 48 * 72);
      assert.ok(varied.pixels.every(color => color >= 0 && color < PIXEL_PALETTE.length));
    }
  }
  assert.equal(signatures.size, CHARACTER_STATES.length - 1, 'All expressive poses differ; LANDED deliberately uses the neutral IDLE silhouette');
});

test('explicit IDLE is quiet breathing, while the FSM selects look/blink/stretch separately', () => {
  const idle = (frame: number) => buildPixelFrame({ state: 'idle', behavior: 'IDLE', frame }).pixels;
  assert.deepEqual(idle(0), idle(4));
  assert.deepEqual(idle(1), idle(9), 'No automatic idle handwave');
  assert.deepEqual(idle(0), idle(12), 'No automatic idle stretch');
  assert.ok(new Set(Array.from({ length: 16 }, (_, frame) => Buffer.from(idle(frame)).toString('base64'))).size <= 2, 'Idle only has a tiny breathing displacement');
  assert.notDeepEqual(buildPixelFrame({ state: 'idle', behavior: 'BLINK' }).pixels, idle(0));
  assert.notDeepEqual(buildPixelFrame({ state: 'idle', behavior: 'LOOK_AROUND', gaze: -1 }).pixels, idle(0));
  assert.notDeepEqual(buildPixelFrame({ state: 'idle', behavior: 'STRETCH', progress: 0.5 }).pixels, idle(0));
});

test('sleep closes eyes and wake rises through its internal seated transition into stretch', () => {
  const sleep = buildPixelFrame({ state: 'idle', behavior: 'SLEEP', frame: 1 }).pixels;
  const awake = buildPixelFrame({ state: 'idle', behavior: 'IDLE', frame: 1 }).pixels;
  const wakeStart = buildPixelFrame({ state: 'idle', behavior: 'WAKE_UP', progress: 0, frame: 1 }).pixels;
  const wakeMiddle = buildPixelFrame({ state: 'idle', behavior: 'WAKE_UP', progress: 0.5, frame: 1 }).pixels;
  const wakeEnd = buildPixelFrame({ state: 'idle', behavior: 'WAKE_UP', progress: 1, frame: 1 }).pixels;
  assert.deepEqual(wakeStart, sleep, 'Wake starts with the sleeping pose');
  assert.notDeepEqual(wakeMiddle, sleep, 'Half-awake seated pose opens eyes');
  assert.notDeepEqual(wakeEnd, wakeMiddle, 'Wake finishes standing and stretching');
  assert.deepEqual(wakeEnd, buildPixelFrame({ state: 'idle', behavior: 'STRETCH', progress: 1, frame: 1 }).pixels);
  assert.ok(region(sleep, 0, 69, 48, 3).every(color => color === 0), 'Curled legs stay on the horizontal resting baseline');
  assert.ok(region(awake, 16, 69, 16, 3).some(color => color !== 0));
  assert.ok(region(sleep, 30, 14, 15, 23).some(color => color === 8), 'Rising Zzz pixels sit above the resting head');
  assert.ok(region(sleep, 14, 60, 5, 4).some(color => color === 10), 'Dim hands support the cheek instead of hanging beneath an upright torso');
  assert.notDeepEqual(buildPixelFrame({ state: 'idle', behavior: 'SLEEP_TALK', frame: 1 }).pixels, sleep);
});

test('sleep breath moves the chest, cheek and loose locks while folded boots and forearms stay planted', () => {
  const sleep = (frame: number) => buildPixelFrame({ state: 'idle', behavior: 'SLEEP', frame }).pixels;
  const settled = sleep(0);
  for (let frame = 1; frame < 8; frame++) {
    assert.deepEqual(region(sleep(frame), 30, 60, 15, 9), region(settled, 30, 60, 15, 9), 'Slim curled legs do not hop with the breath');
    assert.deepEqual(region(sleep(frame), 14, 61, 3, 2), region(settled, 14, 61, 3, 2), 'The supporting palms remain under the cheek');
    assert.deepEqual(region(sleep(frame), 17, 60, 7, 1), region(settled, 17, 60, 7, 1), 'The folded forearm stays on its resting baseline');
    assert.ok(region(sleep(frame), 0, 69, 48, 3).every(color => color === 0));
  }
  assert.notDeepEqual(region(sleep(2), 25, 49, 10, 10), region(settled, 25, 49, 10, 10), 'The chest expands locally');
  assert.notDeepEqual(region(sleep(3), 8, 37, 18, 20), region(settled, 8, 37, 18, 20), 'The original angular head settles independently');
  assert.notDeepEqual(region(sleep(5), 0, 48, 10, 12), region(settled, 0, 48, 10, 12), 'The pointed trailing hair follows the exhale');
  assert.deepEqual(sleep(8), settled, 'The slow sleep cycle wraps after eight phases');
  assert.notDeepEqual(sleep(4), settled, 'Sleep is not four repeated phases');
  for (const frame of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const core = region(sleep(frame), 26, 52, 6, 7);
    assert.ok(core.includes(10), 'The core stays mostly shadow green');
    assert.ok(core.filter(color => color === 8).length <= 1, 'Only one core pixel pulses brighter');
    assert.ok(!core.includes(9), 'Sleep has no bright specular core');
  }
  assert.notDeepEqual(region(sleep(2), 26, 52, 6, 7), region(settled, 26, 52, 6, 7));
});

test('pixel Zs rise, dim and disappear, and sleep talk is a short closed-eye murmur', () => {
  const sleep = (frame: number) => buildPixelFrame({ state: 'idle', behavior: 'SLEEP', frame }).pixels;
  assert.equal(sleep(0)[28 * 48 + 35], 8, 'A fresh Z is neon green');
  assert.equal(sleep(1)[25 * 48 + 37], 10, 'The same Z rises three pixels and fades into shadow green');
  assert.equal(sleep(0)[19 * 48 + 41], 10, 'The oldest visible Z is dim');
  assert.ok(region(sleep(1), 43, 16, 3, 5).every(color => color === 0), 'The oldest Z disappears before the next birth');
  for (let frame = 0; frame < 8; frame++) assert.ok(region(sleep(frame), 28, 14, 18, 25).every(color => [0, 8, 10].includes(color)), 'Sleep glyphs use only existing green tones');
  const murmur = (frame: number) => buildPixelFrame({ state: 'idle', behavior: 'SLEEP_TALK', frame }).pixels;
  assert.deepEqual(region(murmur(1), 8, 40, 17, 13), region(sleep(1), 8, 40, 17, 13), 'Murmuring keeps the same closed eyes and fringe');
  assert.notDeepEqual(region(murmur(0), 28, 28, 13, 7), region(murmur(2), 28, 28, 13, 7), 'Murmur dots appear progressively');
});

test('sleep sampling is slow and bounded, static preferences freeze poses, and wake endpoints retain identity', () => {
  const animation = new AnimationController();
  const snapshot = { state: 'SLEEP' as const, startedAt: 100, durationMs: 60_000 };
  assert.equal(animation.sample(snapshot, 999).frame, 0);
  assert.equal(animation.sample(snapshot, 1000).frame, 1);
  assert.equal(animation.sample(snapshot, 6400).frame, 7);
  assert.equal(animation.sample(snapshot, 7300).frame, 0);
  assert.equal(animation.renderInterval('SLEEP', false, false), 900);
  assert.equal(animation.renderInterval('SLEEP', false, true), 1200);
  assert.equal(animation.renderInterval('SLEEP', true, false), 0);
  for (const behavior of ['SLEEP', 'SLEEP_TALK', 'WAKE_UP'] as const) {
    const state = { ...snapshot, state: behavior };
    const staticPose = animation.sample(state, 100, { static: true, gaze: 1, lean: -1, offsetY: 3, glitch: true });
    assert.deepEqual(animation.sample(state, 20_000, { static: true }), staticPose, 'Calm/reduced sampling is independent of time and pointer motion');
    assert.equal(staticPose.frame, 0); assert.equal(staticPose.progress, 0); assert.equal(staticPose.glitch, false);
  }
  for (let frame = 0; frame < 8; frame++) {
    assert.deepEqual(buildPixelFrame({ state: 'idle', behavior: 'WAKE_UP', progress: 0, frame }).pixels, buildPixelFrame({ state: 'idle', behavior: 'SLEEP', frame }).pixels);
    assert.deepEqual(buildPixelFrame({ state: 'idle', behavior: 'WAKE_UP', progress: 1, frame }).pixels, buildPixelFrame({ state: 'idle', behavior: 'STRETCH', progress: 1, frame }).pixels);
  }
});

test('walk/run use alternate leg phases and facing mirrors correctly', () => {
  for (const behavior of ['WALK', 'RUN'] as const) {
    const first = buildPixelFrame({ state: 'idle', behavior, frame: 0, facing: 1 }).pixels;
    const alternate = buildPixelFrame({ state: 'idle', behavior, frame: 2, facing: 1 }).pixels;
    assert.notDeepEqual(region(first, 8, 46, 32, 24), region(alternate, 8, 46, 32, 24));
    const left = buildPixelFrame({ state: 'idle', behavior, frame: 0, facing: -1 }).pixels;
    for (let y = 0; y < 72; y++) for (let x = 0; x < 48; x++) assert.equal(left[y * 48 + x], first[y * 48 + 47 - x]);
  }
});

test('removed reclining behavior cannot select an awake lounge frame', () => {
  assert.ok(!CHARACTER_STATES.some(state => String(state) === 'SIT'));
  const unsupported = { state: 'idle' as const, behavior: 'SIT' as CompanionPose['behavior'], frame: 0 };
  assert.deepEqual(buildPixelFrame(unsupported).pixels, buildPixelFrame({ state: 'idle', frame: 0 }).pixels, 'An obsolete behavior value falls back to the ordinary character');
});

test('removing reclining leaves all sleep, wake and carried frames pixel-identical', () => {
  // Fingerprints captured before changing the rest behavior, across phases,
  // wake progress, lean and mirror directions protect the established art.
  const expected = {
    SLEEP: 'c365161cf3319ed409c7a7d592cd8d5434b4974a6facf7c5c1c7f76c709f82bf',
    SLEEP_TALK: 'e659d3eff4bd95b3309716f55e8dfddf60d741b3fe1f34970f576810e816aa1c',
    WAKE_UP: 'd0960de9d3120a847a48236a8fb32a910c9362ecee864a9b635bdca2e1fcdcc1',
    DRAGGED: '6cf6500d7c9857cd3acfcee96cc28e0b2e21f103cfc388cc253d8452c2d494cf',
  };
  for (const behavior of ['SLEEP', 'SLEEP_TALK', 'WAKE_UP', 'DRAGGED'] as const) {
    const hash = createHash('sha256');
    for (let frame = 0; frame < 8; frame++) for (const progress of [0, 0.5, 1]) for (const lean of [-1, 0, 1] as const) for (const facing of [-1, 1] as const) {
      hash.update(buildPixelFrame({ state: 'idle', behavior, frame, progress, lean, facing }).pixels);
    }
    assert.equal(hash.digest('hex'), expected[behavior], `${behavior} preserves the previous artwork exactly`);
  }
});

test('dragged lean, gaze and landing progression are integer changes with bounded control inputs', () => {
  const dragged = buildPixelFrame({ state: 'idle', behavior: 'DRAGGED', frame: 0 }).pixels;
  assert.deepEqual(dragged, buildPixelFrame({ state: 'idle', lifted: true, frame: 0 }).pixels);
  assert.notDeepEqual(buildPixelFrame({ state: 'idle', behavior: 'DRAGGED', lean: -1 }).pixels, dragged);
  for (const lean of [-1, 1] as const) {
    const carried = buildPixelFrame({ state: 'idle', behavior: 'DRAGGED', lean, frame: 0 }).pixels;
    assert.deepEqual(region(carried, 0, 0, 48, 35), region(dragged, 0, 0, 48, 35), 'Head, mane and shoulder grip stay fixed while lower limbs trail');
    assert.ok(region(carried, 16, 23, 17, 5).includes(13), 'The startled face retains small blush accents');
  }
  assert.ok(region(dragged, 0, 0, 48, 3).every(color => color === 0), 'There is no stretched hair tuft/handle');
  for (const frame of [1, 2, 3]) {
    assert.deepEqual(region(buildPixelFrame({ state: 'idle', behavior: 'DRAGGED', frame }).pixels, 0, 0, 48, 35), region(dragged, 0, 0, 48, 35), 'Carrying does not bob the whole body or distort the shared head');
  }
  const bootCenter = (lean: -1 | 0 | 1, facing: -1 | 1) => {
    const pixels = buildPixelFrame({ state: 'idle', behavior: 'DRAGGED', lean, facing, frame: 0 }).pixels;
    const xs: number[] = [];
    for (let y = 58; y < 72; y++) for (let x = 0; x < 48; x++) if (pixels[y * 48 + x] === 5) xs.push(x);
    return xs.reduce((sum, x) => sum + x, 0) / xs.length;
  };
  for (const facing of [-1, 1] as const) {
    assert.ok(bootCenter(1, facing) < bootCenter(0, facing), 'Rightward pointer motion leaves the dangling boots behind on screen');
    assert.ok(bootCenter(-1, facing) > bootCenter(0, facing), 'Leftward pointer motion trails to the right, including mirrored poses');
  }
  assert.notDeepEqual(buildPixelFrame({ state: 'idle', behavior: 'LOOK_AROUND', gaze: -1 }).pixels, buildPixelFrame({ state: 'idle', behavior: 'LOOK_AROUND', gaze: 1 }).pixels);
  const neutralLanding = buildPixelFrame({ state: 'idle', behavior: 'LANDED', progress: 0 }).pixels;
  assert.deepEqual(neutralLanding, buildPixelFrame({ state: 'idle', behavior: 'IDLE', frame: 0 }).pixels);
  for (const frame of [1, 2, 3]) assert.deepEqual(buildPixelFrame({ state: 'idle', behavior: 'LANDED', frame, progress: frame / 3 }).pixels, neutralLanding, 'Landing does not alternate hands, spread legs or dance');
  assert.deepEqual(buildPixelFrame({ state: 'idle', behavior: 'IDLE', offsetY: 999 }).pixels, buildPixelFrame({ state: 'idle', behavior: 'IDLE', offsetY: 3 }).pixels);
  assert.deepEqual(buildPixelFrame({ state: 'idle', behavior: 'WAKE_UP', progress: 0.51 }).pixels, buildPixelFrame({ state: 'idle', behavior: 'WAKE_UP', progress: 0.55 }).pixels, 'Progress quantization avoids unbounded per-tick cache variants');
});

test('SpriteRenderer accepts CompanionPose directly without adding timers or image resources', () => {
  let draws = 0;
  const context = { imageSmoothingEnabled: true, createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData: () => { draws++; } };
  const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  const renderer = new SpriteRenderer(canvas);
  for (const behavior of CHARACTER_STATES) {
    const pose: CompanionPose = { behavior, frame: 1, progress: 0.5, gaze: 0, lean: 0, offsetY: 0, facing: 1 };
    assert.doesNotThrow(() => renderer.render(pose));
  }
  assert.equal(draws, CHARACTER_STATES.length);
  assert.equal(canvas.width, 48); assert.equal(canvas.height, 72); assert.equal(context.imageSmoothingEnabled, false);
});

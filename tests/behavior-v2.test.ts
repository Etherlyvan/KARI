import test from 'node:test';
import assert from 'node:assert/strict';
import { BehaviorSystem, DEFAULT_BEHAVIOR_CONFIG } from '../apps/widget/src/companion/BehaviorSystem.js';
import { AnimationController } from '../apps/widget/src/companion/AnimationController.js';
import { EmotionController } from '../apps/widget/src/companion/EmotionController.js';
import { ConversationReactions } from '../apps/widget/src/companion/ConversationReactions.js';
import { CHARACTER_STATES, type BehaviorEnvironment, type CharacterState } from '../apps/widget/src/companion/types.js';

function environment(now: number, overrides: Partial<BehaviorEnvironment> = {}): BehaviorEnvironment {
  return { now, lastInteraction: 0, typing: false, talking: false, thinking: false, dragged: false, landed: false,
    pointerNear: false, bottomEdge: true, moving: false, reduced: false, canMove: false, homeSafe: true, ...overrides };
}
function seeded(seed = 42) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

test('natural sleep follows yawn directly, waits for a safe bottom, then sleep talks and wakes', () => {
  const behavior = new BehaviorSystem({}, () => 0.5); behavior.reset(0);
  assert.ok(!CHARACTER_STATES.some(state => String(state) === 'SIT'));
  assert.equal(behavior.update(environment(240_001, { homeSafe: false, bottomEdge: false })).state, 'YAWN');
  const yawn = behavior.snapshot;
  assert.equal(behavior.update(environment(yawn.startedAt + yawn.durationMs - 1)).state, 'YAWN', 'The slow yawn finishes before sleep');
  assert.equal(behavior.update(environment(yawn.startedAt + yawn.durationMs, { homeSafe: false, bottomEdge: false })).state, 'YAWN');
  assert.equal(behavior.update(environment(yawn.startedAt + yawn.durationMs + 10_000, { homeSafe: true, bottomEdge: false })).state, 'YAWN', 'A safe point away from the bottom cannot start sleep');
  assert.equal(behavior.update(environment(yawn.startedAt + yawn.durationMs + 10_001, { homeSafe: false, bottomEdge: true })).state, 'YAWN', 'The bottom must also be safe');
  const sleeping = behavior.update(environment(yawn.startedAt + yawn.durationMs + 10_002));
  assert.equal(sleeping.state, 'SLEEP');
  assert.ok(sleeping.durationMs >= DEFAULT_BEHAVIOR_CONFIG.sleepMinMs && sleeping.durationMs <= DEFAULT_BEHAVIOR_CONFIG.sleepMaxMs);
  assert.equal(behavior.update(environment(sleeping.startedAt + sleeping.durationMs / 2)).state, 'SLEEP_TALK');
  const mumble = behavior.snapshot;
  assert.equal(behavior.update(environment(mumble.startedAt + mumble.durationMs)).state, 'SLEEP');
  assert.equal(behavior.update(environment(sleeping.startedAt + sleeping.durationMs)).state, 'WAKE_UP');
});

test('a safe bottom enters sleep immediately when the yawn ends with no extra rest pause', () => {
  const behavior = new BehaviorSystem({}, () => 0.5); behavior.reset(0);
  const yawn = behavior.update(environment(240_001));
  assert.equal(yawn.state, 'YAWN');
  const sleeping = behavior.update(environment(yawn.startedAt + yawn.durationMs));
  assert.equal(sleeping.state, 'SLEEP');
  assert.equal(sleeping.startedAt, yawn.startedAt + yawn.durationMs);
});

test('fresh attention cancels a pending bedtime instead of forcing sleep through interaction', () => {
  const behavior = new BehaviorSystem({}, () => .5); behavior.reset(0);
  assert.equal(behavior.update(environment(240_001)).state, 'YAWN');
  assert.equal(behavior.update(environment(240_500, { lastInteraction: 240_500 })).state, 'IDLE');
  assert.equal(behavior.update(environment(250_000, { lastInteraction: 240_500 })).state === 'SLEEP', false);
});

test('forced speech and listening cannot cut the wake sequence short or restart it', () => {
  const behavior = new BehaviorSystem({}, () => 0.5); behavior.reset(0);
  behavior.force('SLEEP', 10, 60_000); behavior.force('TALK', 100, 1200);
  assert.equal(behavior.snapshot.state, 'WAKE_UP'); assert.equal(behavior.wake(200), 1000);
  behavior.force('LISTEN', 300, 1300);
  assert.equal(behavior.snapshot.startedAt, 100);
  assert.equal(behavior.update(environment(1100, { typing: true })).state, 'WAKE_UP');
  assert.equal(behavior.update(environment(1200, { typing: true })).state, 'LISTEN');
});

test('physical and active conversation priorities override discretionary personality states', () => {
  const behavior = new BehaviorSystem({}, seeded()); behavior.reset(0); behavior.force('DANCE', 0);
  assert.equal(behavior.update(environment(100, { dragged: true, typing: true, talking: true })).state, 'DRAGGED');
  assert.equal(behavior.update(environment(200, { landed: true, typing: true })).state, 'LANDED');
  assert.equal(behavior.update(environment(900, { typing: true, thinking: true, talking: true })).state, 'LISTEN');
  assert.equal(behavior.update(environment(1000, { thinking: true, talking: true })).state, 'THINKING');
  assert.equal(behavior.update(environment(1100, { talking: true })).state, 'TALK');
});

test('forced reaction holds its duration and queued speech yields to current typing after wake', () => {
  const behavior = new BehaviorSystem({}, () => 0.5); behavior.reset(0);
  behavior.force('CURIOUS', 100, 220);
  assert.equal(behavior.update(environment(200, { moving: true, canMove: true })).state, 'CURIOUS', 'movement anticipation must not disappear on the next coordinator tick');
  assert.equal(behavior.update(environment(321, { moving: true, canMove: true })).state, 'CURIOUS', 'Blink is an overlay and does not switch the face mid-relocation');
  behavior.force('SLEEP', 400, 60000); behavior.force('TALK', 500, 1800);
  assert.equal(behavior.update(environment(1600, { typing: true })).state, 'LISTEN');
});

test('drop settles into a quiet idle interval instead of immediately dancing', () => {
  const behavior = new BehaviorSystem({}, () => .999); behavior.reset(0);
  behavior.force('DRAGGED', 100, Infinity);
  assert.equal(behavior.update(environment(200, { landed: true })).state, 'LANDED');
  assert.equal(behavior.update(environment(850)).state, 'IDLE');
  assert.equal(behavior.update(environment(6000)).state, 'IDLE');
});

test('cooldowns and slower pose holds retain variety without an immediate repeated rare action', () => {
  const behavior = new BehaviorSystem({ rareCooldownMs: 60_000 }, seeded(91)); behavior.reset(0); behavior.force('PLAY', 0, 1);
  let now = 1000;
  const observed: CharacterState[] = [];
  while (now < 120_000) {
    const current = behavior.update(environment(now, { lastInteraction: now }));
    if (now < 60_000) assert.notEqual(current.state, 'PLAY');
    observed.push(current.state); now += Math.max(1000, current.durationMs + 1);
  }
  assert.ok(new Set(observed).size >= 4, 'weighted choices should provide variety rather than a single loop');
});

test('optional expressions hold long enough, then give a full neutral pause', () => {
  for (const state of ['LOOK_AROUND', 'CURIOUS', 'HAPPY', 'BORED'] as const) {
    const behavior = new BehaviorSystem({}, () => .5); behavior.reset(0); behavior.force(state, 0);
    const held = behavior.snapshot;
    assert.ok(held.durationMs >= 6000);
    assert.ok(held.durationMs <= 11_000);
    assert.equal(behavior.update(environment(held.durationMs - 1, { lastInteraction: held.durationMs - 1 })).state, state);
    const neutral = behavior.update(environment(held.durationMs + 1, { lastInteraction: held.durationMs + 1 }));
    assert.equal(neutral.state, 'IDLE'); assert.ok(neutral.durationMs >= 8000 && neutral.durationMs <= 12_000);
    assert.equal(behavior.update(environment(neutral.startedAt + neutral.durationMs - 1, { lastInteraction: neutral.startedAt })).state, 'IDLE');
    behavior.force(state, neutral.startedAt + neutral.durationMs);
    assert.equal(behavior.update(environment(neutral.startedAt + neutral.durationMs + 10, { typing: true })).state, 'LISTEN', 'Real typing still interrupts immediately');
  }
});

test('reduced motion avoids autonomous gestures/locomotion but retains interaction and sleep semantics', () => {
  const behavior = new BehaviorSystem({}, seeded()); behavior.reset(0); behavior.force('RUN', 0);
  for (let now = 1000; now < 180_000; now += 5000) assert.equal(behavior.update(environment(now, { lastInteraction: now, canMove: true, reduced: true })).state, 'IDLE');
  assert.equal(behavior.update(environment(181_000, { typing: true, reduced: true })).state, 'LISTEN');
  const animation = new AnimationController();
  assert.equal(animation.renderInterval('IDLE', true, false), 0);
});

test('animation is elapsed-time based, bounded and samples every supported state', () => {
  const animation = new AnimationController();
  for (const state of CHARACTER_STATES) {
    const snapshot = { state, startedAt: 1000, durationMs: 4000 };
    const first = animation.sample(snapshot, 2300, { offsetY: 99 });
    assert.deepEqual(animation.sample(snapshot, 2300, { offsetY: 99 }), first);
    assert.ok(first.frame >= 0 && first.frame <= 3); assert.ok(first.progress >= 0 && first.progress <= 1); assert.equal(first.offsetY, 3);
  }
  const idle = { state: 'IDLE' as const, startedAt: 0, durationMs: 10_000 };
  assert.equal(animation.sample(idle, 100).frame, 0); assert.equal(animation.sample(idle, 1400).frame, 1);
});

test('emotion metadata needs explicit trust and invalid hints fall back to local text only', () => {
  const emotions = new EmotionController();
  assert.equal(emotions.resolve('Pesan biasa.', { emotion: 'happy' }), 'neutral');
  assert.equal(emotions.resolve('Pesan biasa.', { emotion: 'happy' }, true), 'happy');
  assert.equal(emotions.resolve('Aku bingung', { emotion: '<script>' }, true), 'confused');
  assert.equal(emotions.resolve('Aku sedang sedih'), 'sad');
  const reactions = new ConversationReactions();
  assert.equal(reactions.resolve({ typing: true, thinking: true, talking: true }), 'LISTEN');
  assert.equal(reactions.resolve({ event: 'response', text: 'Terima kasih' }), 'TALK');
  assert.equal(reactions.resolve({ text: 'Tidak ada petunjuk.' }), 'IDLE');
});

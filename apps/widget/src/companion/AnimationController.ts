import type { BehaviorSnapshot, CharacterState, CompanionPose, Direction } from './types.js';

export interface PoseOptions { gaze?: Direction; lean?: Direction; facing?: Direction; offsetY?: number; glitch?: boolean; static?: boolean; }
const once = new Set<CharacterState>(['BLINK', 'STRETCH', 'YAWN', 'WAKE_UP', 'LANDED']);
const phaseMs: Partial<Record<CharacterState, number>> = {
  IDLE: 1400, BLINK: 60, LOOK_AROUND: 1000, THINKING: 650, STRETCH: 700, YAWN: 700,
  SLEEP: 900, SLEEP_TALK: 400, WAKE_UP: 275, WALK: 170, RUN: 110,
  DANCE: 220, PLAY: 420, CURIOUS: 1000, HAPPY: 500, BORED: 1200, TALK: 200, LISTEN: 900,
  DRAGGED: 280, LANDED: 160,
};
const direction = (value: number | undefined, fallback: Direction = 0): Direction => value === -1 || value === 0 || value === 1 ? value : fallback;

/** Stateless elapsed-time sampling: repaint frequency never advances the animation clock. */
export class AnimationController {
  sample(snapshot: BehaviorSnapshot, now: number, options: PoseOptions = {}): CompanionPose {
    if (options.static) return { behavior: snapshot.state, frame: 0, progress: 0, gaze: 0, lean: 0, facing: direction(options.facing, 1), offsetY: 0, glitch: false };
    const elapsed = Math.max(0, Number.isFinite(now) ? now - snapshot.startedAt : 0);
    const progress = Math.max(0, Math.min(1, elapsed / Math.max(1, snapshot.durationMs)));
    const frame = once.has(snapshot.state) ? Math.min(3, Math.floor(progress * 4)) : Math.floor(elapsed / (phaseMs[snapshot.state] ?? 500)) % (snapshot.state === 'SLEEP' ? 8 : 4);
    const gaze = snapshot.state === 'LOOK_AROUND' ? ([0, -1, 0, 1] as Direction[])[frame]! : snapshot.state === 'CURIOUS' ? 1 : 0;
    const lean: Direction = snapshot.state === 'THINKING' || snapshot.state === 'BORED' ? -1 : snapshot.state === 'CURIOUS' ? 1 : 0;
    const bounce = snapshot.state === 'WALK' || snapshot.state === 'RUN' ? -(frame % 2) : snapshot.state === 'DANCE' || snapshot.state === 'HAPPY' ? -(frame % 2) * 2 : 0;
    const offset = Number.isFinite(options.offsetY) ? options.offsetY! : bounce;
    return {
      behavior: snapshot.state, frame, progress, gaze: direction(options.gaze, gaze as Direction),
      lean: direction(options.lean, lean), facing: direction(options.facing, 1),
      offsetY: Math.round(Math.max(-3, Math.min(3, offset))), glitch: options.glitch ?? false,
    };
  }
  /** Zero means a static sample; the coordinator must not schedule a zero-delay repaint loop. */
  renderInterval(state: CharacterState, reduced: boolean, mobile: boolean): number {
    if (reduced) return 0;
    if (state === 'SLEEP') return mobile ? 1200 : 900;
    if (state === 'BORED') return mobile ? 1600 : 1000;
    if (state === 'IDLE' || state === 'LISTEN') return mobile ? 900 : 600;
    return Math.max(mobile ? 160 : 100, Math.min(400, phaseMs[state] ?? 250));
  }
}

export const CHARACTER_STATES = ['IDLE', 'BLINK', 'LOOK_AROUND', 'THINKING', 'STRETCH', 'YAWN', 'SLEEP', 'SLEEP_TALK', 'WAKE_UP', 'WALK', 'RUN', 'DANCE', 'PLAY', 'CURIOUS', 'HAPPY', 'BORED', 'TALK', 'LISTEN', 'DRAGGED', 'LANDED'] as const;
export type CharacterState = typeof CHARACTER_STATES[number];
export type Direction = -1 | 0 | 1;
export interface Point { x: number; y: number; }
export interface Rect { left: number; top: number; width: number; height: number; }
export interface Personality { energy: number; curiosity: number; mood: number; }
export interface BehaviorConfig {
  decisionMs: number;
  sleepAfterMs: number;
  sleepMinMs: number;
  sleepMaxMs: number;
  moveMinMs: number;
  moveMaxMs: number;
  manualReturnMs: number;
  rareCooldownMs: number;
  /** Legacy option retained for compatibility; blink FX now follows direction. */
  lightningChance: number;
  personality: Personality;
}
export interface BehaviorEnvironment {
  now: number; lastInteraction: number; typing: boolean; talking: boolean; thinking: boolean;
  dragged: boolean; landed: boolean; pointerNear: boolean; bottomEdge: boolean;
  moving: boolean; reduced: boolean; canMove: boolean; homeSafe: boolean;
}
export interface BehaviorSnapshot { state: CharacterState; startedAt: number; durationMs: number; }
export interface CompanionPose {
  behavior: CharacterState; frame: number; progress: number; gaze: Direction;
  lean: Direction; offsetY: number; facing: Direction; glitch?: boolean;
}
export type Emotion = 'happy' | 'curious' | 'calm' | 'sad' | 'confused' | 'neutral';

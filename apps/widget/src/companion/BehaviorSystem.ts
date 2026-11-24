import type { BehaviorConfig, BehaviorEnvironment, BehaviorSnapshot, CharacterState, Personality } from './types.js';

export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = {
  decisionMs: 1000, sleepAfterMs: 240_000, sleepMinMs: 30_000, sleepMaxMs: 90_000,
  moveMinMs: 6000, moveMaxMs: 12_000, manualReturnMs: 12_000,
  rareCooldownMs: 60_000, lightningChance: 0.14,
  personality: { energy: 0.68, curiosity: 0.62, mood: 0.72 },
};

const WAKE_MS = 1100;
const wakeFirst = new Set<CharacterState>(['TALK', 'LISTEN', 'THINKING', 'HAPPY', 'CURIOUS']);
const rare = new Set<CharacterState>(['STRETCH', 'DANCE', 'PLAY', 'RUN', 'BORED']);
const expressive = new Set<CharacterState>(['BLINK', 'LOOK_AROUND', 'STRETCH', 'YAWN', 'WALK', 'RUN', 'DANCE', 'PLAY', 'CURIOUS', 'HAPPY', 'BORED']);
const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));

/** Timer-free FSM. Call update from the coordinator; only ordinary choices are decision-rate limited. */
export class BehaviorSystem {
  readonly config: BehaviorConfig;
  private current: BehaviorSnapshot = { state: 'IDLE', startedAt: 0, durationMs: 10_000 };
  private traits: Personality;
  private initialized = false;
  private lastNow = 0;
  private lastDecision = 0;
  private lastWake = 0;
  private sleepThreshold = 240_000;
  private sleepUntil = 0;
  private sleepStarted = 0;
  private sleepTalkAt = 0;
  private sleepTalkUsed = false;
  private sleepSequence = false;
  private landedWasActive = false;
  private pending?: { state: CharacterState; durationMs?: number };
  private forced?: { state: CharacterState; until: number };
  private cooldowns = new Map<CharacterState, number>();
  private history: CharacterState[] = [];

  constructor(partial: Partial<BehaviorConfig> = {}, private readonly random: () => number = Math.random) {
    this.config = { ...DEFAULT_BEHAVIOR_CONFIG, ...partial, personality: { ...DEFAULT_BEHAVIOR_CONFIG.personality, ...partial.personality } };
    for (const key of ['decisionMs', 'sleepAfterMs', 'sleepMinMs', 'sleepMaxMs', 'moveMinMs', 'moveMaxMs', 'manualReturnMs', 'rareCooldownMs'] as const) {
      const value = this.config[key];
      this.config[key] = Number.isFinite(value) ? Math.max(1000, value) : DEFAULT_BEHAVIOR_CONFIG[key];
    }
    this.config.decisionMs = Math.max(1000, this.config.decisionMs);
    this.config.sleepMaxMs = Math.max(this.config.sleepMinMs, this.config.sleepMaxMs);
    this.config.moveMaxMs = Math.max(this.config.moveMinMs, this.config.moveMaxMs);
    this.config.lightningChance = clamp(this.config.lightningChance);
    this.traits = this.initialTraits();
  }
  get snapshot(): BehaviorSnapshot { return { ...this.current }; }
  get personality(): Personality { return { ...this.traits }; }
  shouldRest(now: number, lastInteraction: number): boolean {
    return this.sleepSequence || now - Math.max(lastInteraction, this.lastWake) >= this.sleepThreshold;
  }
  private initialTraits(): Personality {
    return { energy: clamp(this.config.personality.energy), curiosity: clamp(this.config.personality.curiosity), mood: clamp(this.config.personality.mood) };
  }
  private roll() { const value = this.random(); return Number.isFinite(value) ? Math.max(0, Math.min(0.999999999, value)) : 0.5; }
  private between(min: number, max: number) { return Math.round(min + (max - min) * this.roll()); }
  private expired(now: number) { return now >= this.current.startedAt + this.current.durationMs; }
  private duration(state: CharacterState): number {
    switch (state) {
      case 'BLINK': return 180;
      case 'LOOK_AROUND': return this.between(6000, 9000);
      case 'STRETCH': return 5000;
      case 'YAWN': return 3500;
      case 'WAKE_UP': return WAKE_MS;
      case 'SLEEP': return this.between(this.config.sleepMinMs, this.config.sleepMaxMs);
      case 'SLEEP_TALK': return this.between(1800, 3000);
      case 'DRAGGED': return 1000;
      case 'LANDED': return 650;
      case 'WALK': return this.between(2200, 4000);
      case 'RUN': return this.between(1300, 2200);
      case 'DANCE': return 3200;
      case 'PLAY': return this.between(6000, 8500);
      case 'CURIOUS': return this.between(6000, 9000);
      case 'HAPPY': return this.between(6000, 8000);
      case 'BORED': return this.between(8000, 11_000);
      case 'TALK': return 4500;
      case 'LISTEN': return 2200;
      case 'THINKING': return 4000;
      default: return this.between(8000, 12_000);
    }
  }
  private enter(state: CharacterState, now: number, durationMs = this.duration(state)): BehaviorSnapshot {
    this.current = { state, startedAt: now, durationMs: Math.max(1, durationMs) };
    this.history.push(state); this.history = this.history.slice(-4);
    const cooldown = rare.has(state) ? this.config.rareCooldownMs : state === 'BLINK' ? 7000 : state === 'IDLE' ? 0 : 12_000;
    this.cooldowns.set(state, now + cooldown);
    return this.snapshot;
  }
  reset(now: number): void {
    const timestamp = Number.isFinite(now) ? now : 0;
    this.initialized = true; this.lastNow = timestamp; this.lastWake = timestamp; this.lastDecision = timestamp;
    this.sleepThreshold = this.between(this.config.sleepAfterMs * 0.75, this.config.sleepAfterMs * 1.25);
    this.sleepUntil = 0; this.sleepStarted = 0; this.sleepTalkAt = 0; this.sleepTalkUsed = false; this.sleepSequence = false;
    this.landedWasActive = false; this.pending = undefined; this.forced = undefined; this.cooldowns.clear(); this.history = [];
    this.traits = this.initialTraits(); this.enter('IDLE', timestamp);
  }
  force(state: CharacterState, now: number, durationMs?: number): void {
    if (!this.initialized) this.reset(now);
    if (wakeFirst.has(state) && ['SLEEP', 'SLEEP_TALK', 'WAKE_UP'].includes(this.current.state)) {
      this.pending = { state, durationMs }; this.wake(now); return;
    }
    this.sleepSequence = false; this.pending = undefined; this.forced = undefined;
    if (state === 'SLEEP') { this.beginSleep(now, durationMs); return; }
    this.enter(state, now, durationMs);
    this.forced = { state, until: now + this.current.durationMs };
  }
  /** Remaining wake animation; repeated calls never restart or skip it. */
  wake(now: number): number {
    if (!this.initialized) this.reset(now);
    if (this.current.state === 'WAKE_UP') return Math.max(0, this.current.startedAt + this.current.durationMs - now);
    if (this.current.state !== 'SLEEP' && this.current.state !== 'SLEEP_TALK') return 0;
    this.sleepSequence = false; this.forced = undefined; this.lastWake = now;
    this.sleepThreshold = this.between(this.config.sleepAfterMs * 0.75, this.config.sleepAfterMs * 1.25);
    this.enter('WAKE_UP', now, WAKE_MS);
    return WAKE_MS;
  }
  private beginSleep(now: number, durationMs = this.duration('SLEEP')) {
    this.sleepSequence = false; this.sleepStarted = now; this.sleepUntil = now + durationMs;
    this.sleepTalkAt = now + durationMs * (0.35 + this.roll() * 0.3); this.sleepTalkUsed = false;
    this.enter('SLEEP', now, durationMs);
  }
  private advanceTraits(now: number) {
    const minutes = Math.max(0, Math.min(300_000, now - this.lastNow)) / 60_000;
    const asleep = this.current.state === 'SLEEP' || this.current.state === 'SLEEP_TALK';
    const lively = ['RUN', 'DANCE', 'PLAY', 'WALK'].includes(this.current.state);
    this.traits.energy = clamp(this.traits.energy + minutes * (asleep ? 0.22 : lively ? -0.065 : -0.012));
    this.traits.curiosity = clamp(this.traits.curiosity + minutes * (asleep ? -0.025 : lively ? -0.02 : 0.012));
    this.traits.mood = clamp(this.traits.mood + minutes * (['HAPPY', 'PLAY', 'DANCE'].includes(this.current.state) ? 0.05 : -0.002));
    this.lastNow = now;
  }
  update(env: BehaviorEnvironment): BehaviorSnapshot {
    if (!this.initialized) this.reset(env.now);
    const now = Number.isFinite(env.now) ? Math.max(this.lastNow, env.now) : this.lastNow;
    this.advanceTraits(now);
    const landedEdge = env.landed && !this.landedWasActive; this.landedWasActive = env.landed;
    if (env.dragged) {
      this.sleepSequence = false;
      if (this.current.state !== 'DRAGGED') this.enter('DRAGGED', now);
      return this.snapshot;
    }
    if (landedEdge) { this.sleepSequence = false; return this.enter('LANDED', now); }
    if (this.current.state === 'LANDED' && !this.expired(now)) return this.snapshot;

    const interaction: CharacterState | undefined = env.typing ? 'LISTEN' : env.thinking ? 'THINKING' : env.talking ? 'TALK' : undefined;
    if (this.current.state === 'WAKE_UP') {
      if (!this.expired(now)) return this.snapshot;
      this.lastWake = now;
      if (this.pending) {
        const pending = this.pending; this.pending = undefined;
        // A new live interaction has priority over a queued decorative reaction.
        if (!interaction) { this.force(pending.state, now, pending.durationMs); return this.snapshot; }
      }
      this.enter('IDLE', now);
    }
    if (interaction) {
      this.sleepSequence = false;
      if (this.wake(now) > 0) return this.snapshot;
      if (this.current.state !== interaction) this.enter(interaction, now);
      return this.snapshot;
    }
    if (this.current.state === 'LANDED') {
      this.forced = undefined;
      return this.enter('IDLE', now, 6000);
    }
    if (this.current.state === 'SLEEP' || this.current.state === 'SLEEP_TALK') {
      if (env.lastInteraction > this.sleepStarted || now >= this.sleepUntil) { this.wake(now); return this.snapshot; }
      if (this.current.state === 'SLEEP_TALK') {
        if (this.expired(now)) this.enter('SLEEP', now, this.sleepUntil - now);
      } else if (!env.reduced && !this.sleepTalkUsed && now >= this.sleepTalkAt) {
        this.sleepTalkUsed = true;
        if (this.roll() < 0.65) this.enter('SLEEP_TALK', now, Math.min(this.duration('SLEEP_TALK'), this.sleepUntil - now));
      }
      return this.snapshot;
    }
    if (env.reduced && expressive.has(this.current.state) && !this.sleepSequence) this.enter('IDLE', now);
    if (this.forced) {
      if (this.forced.state === this.current.state && now < this.forced.until) return this.snapshot;
      this.forced = undefined;
    }
    if (['DRAGGED', 'LISTEN', 'THINKING', 'TALK'].includes(this.current.state)) this.enter('IDLE', now);
    if (env.moving && env.canMove && !env.reduced) {
      return this.snapshot;
    }
    const inactiveFor = Math.max(0, now - Math.max(env.lastInteraction, this.lastWake));
    if (this.sleepSequence && inactiveFor < this.sleepThreshold) {
      this.sleepSequence = false; return this.enter('IDLE', now);
    }
    if (inactiveFor >= this.sleepThreshold || this.sleepSequence) {
      if (!this.sleepSequence) { this.sleepSequence = true; return this.enter('YAWN', now); }
      if (this.current.state === 'YAWN' && this.expired(now) && env.homeSafe && env.bottomEdge) this.beginSleep(now);
      return this.snapshot;
    }
    if (!this.expired(now)) return this.snapshot;
    if (this.current.state !== 'IDLE') return this.enter('IDLE', now);
    if (now - this.lastDecision < this.config.decisionMs) {
      return this.snapshot;
    }
    this.lastDecision = now;
    if (env.reduced) return this.enter('IDLE', now);
    const p = this.traits;
    const choices: Array<[CharacterState, number]> = [
      ['IDLE', 3], ['BLINK', 1.5], ['LOOK_AROUND', 1 + p.curiosity * 2],
      ['CURIOUS', 0.5 + p.curiosity + (env.pointerNear ? 2 : 0)],
      ['STRETCH', 0.25 + (1 - p.energy)],
      ['YAWN', inactiveFor > 60_000 ? 0.2 + (1 - p.energy) : 0],
      ['BORED', inactiveFor > 60_000 ? 0.3 + (1 - p.mood) : 0],
      ['HAPPY', p.mood > 0.5 ? p.mood * 0.4 : 0],
      ['PLAY', p.energy > 0.35 ? p.curiosity * 0.6 : 0],
    ];
    const recent = this.history.slice(-3);
    const eligible = choices.filter(([state, weight]) => weight > 0 && state !== this.current.state && !recent.includes(state) && (this.cooldowns.get(state) ?? 0) <= now);
    let draw = this.roll() * eligible.reduce((sum, [, weight]) => sum + weight, 0);
    for (const [state, weight] of eligible) { draw -= weight; if (draw < 0) return this.enter(state, now); }
    return this.enter('IDLE', now);
  }
}

import { PixelKariRenderer, type PixelState } from '../pixel-art.js';
import type { CompanionPose } from './types.js';

/** Stateless bridge: the character controller owns RAF, decisions and visibility. */
export class SpriteRenderer {
  private readonly renderer: PixelKariRenderer;

  constructor(canvas: HTMLCanvasElement) { this.renderer = new PixelKariRenderer(canvas); }

  render(pose: CompanionPose): void {
    const state: PixelState = pose.behavior === 'THINKING' ? 'think'
      : pose.behavior === 'TALK' ? 'talk'
      : pose.behavior === 'HAPPY' ? 'happy' : 'idle';
    this.renderer.render({ state, ...pose, lifted: pose.behavior === 'DRAGGED' });
  }
}

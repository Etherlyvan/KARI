import { EmotionController, type EmotionMetadata } from './EmotionController.js';
import type { CharacterState } from './types.js';

export interface ConversationSignal {
  dragged?: boolean; landed?: boolean; typing?: boolean; thinking?: boolean; talking?: boolean;
  event?: 'opened' | 'sent' | 'response' | 'saved' | 'error' | 'cancelled';
  text?: string; metadata?: EmotionMetadata; metadataTrusted?: boolean;
}

/** Pure UI-event mapping. Force the result through BehaviorSystem so waking keeps its priority. */
export class ConversationReactions {
  constructor(private readonly emotions = new EmotionController()) {}
  resolve(signal: ConversationSignal): CharacterState {
    if (signal.dragged) return 'DRAGGED';
    if (signal.landed) return 'LANDED';
    if (signal.typing) return 'LISTEN';
    if (signal.thinking || signal.event === 'sent') return 'THINKING';
    if (signal.talking || signal.event === 'response') return 'TALK';
    if (signal.event === 'cancelled') return 'IDLE';
    if (signal.event === 'saved') return 'HAPPY';
    if (signal.event === 'opened') return 'LISTEN';
    if (signal.event === 'error') return 'THINKING';
    return this.emotions.stateFor(this.emotions.resolve(signal.text, signal.metadata, signal.metadataTrusted ?? false));
  }
}

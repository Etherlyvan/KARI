import type { CharacterState, Emotion } from './types.js';

export interface EmotionMetadata { emotion?: unknown; confidence?: unknown; }
const emotions = new Set<Emotion>(['happy', 'curious', 'calm', 'sad', 'confused', 'neutral']);

/** Decorative hints only. Never classifies permission, routes models, or calls an API. */
export class EmotionController {
  resolve(text = '', metadata?: EmotionMetadata, trusted = false): Emotion {
    if (trusted && metadata && typeof metadata.emotion === 'string' && emotions.has(metadata.emotion as Emotion)) return metadata.emotion as Emotion;
    const input = text.slice(0, 1024).normalize('NFKC').toLocaleLowerCase();
    if (/\b(sedih|kecewa|capek|lelah|stres|sad|tired|upset|lonely)\b/u.test(input)) return 'sad';
    if (/\b(bingung|gagal|error|confused|confusing)\b|tidak paham|nggak paham/u.test(input)) return 'confused';
    if (/\b(makasih|terimakasih|thanks|senang|berhasil|hebat|happy|great)\b|terima kasih|thank you/u.test(input)) return 'happy';
    if (/\b(tenang|santai|istirahat|calm|relax)\b/u.test(input)) return 'calm';
    if (/\b(penasaran|kenapa|bagaimana|why|how|curious)\b|\?/u.test(input)) return 'curious';
    return 'neutral';
  }
  stateFor(emotion: Emotion): CharacterState {
    switch (emotion) {
      case 'happy': return 'HAPPY';
      case 'curious': return 'CURIOUS';
      case 'sad': return 'LISTEN';
      case 'confused': return 'THINKING';
      case 'calm': return 'IDLE';
      default: return 'IDLE';
    }
  }
}

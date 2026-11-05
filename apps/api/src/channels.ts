import type { FastifyInstance } from 'fastify';
import { handleTelegramUpdate, verifyWebhookSecret } from './owner.js';
import type { PrismaPersistence, ReminderRecord } from './persistence.js';
import type { DeliveryResult, ReminderSender } from './scheduler.js';

export interface TelegramConfig { enabled: boolean; ownerId: string; token: string; webhookSecret: string; }
export function telegramConfig(env = process.env): TelegramConfig {
  if (!['true', 'false', undefined].includes(env.TELEGRAM_ENABLED)) throw new Error('TELEGRAM_ENABLED must be true or false.');
  const enabled = env.TELEGRAM_ENABLED === 'true';
  const ownerId = env.TELEGRAM_OWNER_ID ?? '', token = env.TELEGRAM_BOT_TOKEN ?? '', webhookSecret = env.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (enabled && (!/^[1-9]\d{0,19}$/u.test(ownerId) || !/^\d+:[A-Za-z0-9_-]{20,}$/u.test(token) || !verifyWebhookSecret(webhookSecret, webhookSecret))) {
    throw new Error('Telegram owner, bot token and webhook secret must be configured securely.');
  }
  return { enabled, ownerId, token, webhookSecret };
}

export class TelegramSender implements ReminderSender {
  constructor(private readonly config: TelegramConfig, private readonly fetcher = globalThis.fetch) {}
  async send(reminder: ReminderRecord, signal: AbortSignal): Promise<DeliveryResult> {
    if (reminder.channel !== 'telegram' || reminder.recipient !== this.config.ownerId) return { status: 'failed', errorCode: 'RECIPIENT_DENIED' };
    return this.sendText(reminder.recipient, `Pengingat: ${reminder.text}`, signal);
  }
  async sendText(recipient: string, text: string, signal: AbortSignal): Promise<DeliveryResult> {
    if (!this.config.enabled || recipient !== this.config.ownerId) return { status: 'failed', errorCode: 'CHANNEL_DISABLED' };
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${this.config.token}/sendMessage`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: recipient, text: Array.from(text).slice(0, 3500).join('') }),
      });
      if (Number(response.headers.get('content-length') ?? 0) > 64 * 1024 || !response.body) return { status: 'unknown', errorCode: 'INVALID_CHANNEL_RESPONSE' };
      const reader = response.body.getReader(); let size = 0; const parts: Uint8Array[] = [];
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 64 * 1024) { await reader.cancel(); return { status: 'unknown', errorCode: 'INVALID_CHANNEL_RESPONSE' }; } parts.push(value); } }
      finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(parts).toString('utf8')) as { ok?: boolean; result?: { message_id?: number }; error_code?: number };
      if (response.ok && data.ok && Number.isSafeInteger(data.result?.message_id)) return { status: 'accepted', providerId: String(data.result!.message_id) };
      if (response.status === 429 && data.ok === false) return { status: 'retryable', errorCode: 'TELEGRAM_RATE_LIMITED' };
      if ([400, 401, 403].includes(response.status) && data.ok === false) return { status: 'failed', errorCode: 'TELEGRAM_REJECTED' };
      return { status: 'unknown', errorCode: 'TELEGRAM_OUTCOME_UNKNOWN' };
    } catch { return { status: 'unknown', errorCode: 'TELEGRAM_OUTCOME_UNKNOWN' }; }
  }
}

export function registerTelegram(server: FastifyInstance, config: TelegramConfig, store: PrismaPersistence, sender: TelegramSender,
  chat: (input: { ownerId: string; requestId: string; message: string }) => Promise<string>) {
  type UpdateState = { expires: number; status: 'processing' | 'reply-pending' | 'completed' | 'unknown'; attempts: number; result?: { chatId: string; text: string } };
  const seen = new Map<string, UpdateState>(); let active = false;
  let minute = 0, attempts = 0;
  server.post('/kari/api/telegram/webhook', async (request, reply) => {
    const header = request.headers['x-telegram-bot-api-secret-token'];
    const receivedSecret = typeof header === 'string' ? header : undefined;
    if (!verifyWebhookSecret(config.webhookSecret, receivedSecret)) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    const body = request.body as { update_id?: unknown; message?: { from?: { id?: unknown }; chat?: { id?: unknown; type?: unknown } } } | null;
    if (!body || !Number.isSafeInteger(body.update_id)) return reply.code(400).send({ error: 'INVALID_UPDATE' });
    // Do not let unrelated users of a public Telegram bot fill the owner's dedupe state.
    if (!Number.isSafeInteger(body.message?.from?.id) || String(body.message?.from?.id) !== config.ownerId || String(body.message?.chat?.id) !== config.ownerId || body.message?.chat?.type !== 'private') return { status: 'ignored' };
    const now = Date.now(); for (const [id, state] of seen) if (state.expires <= now) seen.delete(id);
    const currentMinute = Math.floor(now / 60_000);
    if (minute !== currentMinute) { minute = currentMinute; attempts = 0; }
    if (++attempts > 20) return reply.code(429).header('Retry-After', '60').send({ error: 'RATE_LIMITED' });
    const id = String(body.update_id);
    const previous = seen.get(id);
    if (previous && ['completed', 'unknown'].includes(previous.status)) return { status: 'duplicate' };
    if (active || seen.size >= 2000) return reply.code(503).send({ error: 'BUSY' });
    const state: UpdateState = previous ?? { expires: now + 24 * 3600_000, status: 'processing', attempts: 0 };
    active = true; seen.set(id, state);
    try {
      const result = state.result ?? await handleTelegramUpdate(request.body, { ownerId: config.ownerId, webhookSecret: config.webhookSecret, receivedSecret, store, chat });
      if (result) {
        state.result = result; state.attempts++;
        const delivery = await sender.sendText(result.chatId, result.text, AbortSignal.timeout(20_000));
        request.log.info({ event: 'owner_reply', status: delivery.status }, 'Owner reply processed');
        if (delivery.status === 'retryable' && state.attempts < 3) {
          state.status = 'reply-pending';
          return reply.code(503).header('Retry-After', '60').send({ error: 'REPLY_RETRY_LATER' });
        }
        state.status = delivery.status === 'unknown' ? 'unknown' : 'completed';
        state.result = undefined;
      } else {
        state.status = 'completed';
      }
      return { status: 'processed' };
    } catch {
      // A thrown operation may already have committed: never replay it blindly.
      state.status = 'unknown'; state.result = undefined;
      return { status: 'unknown' };
    }
    finally { active = false; }
  });
}

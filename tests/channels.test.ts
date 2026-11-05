import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramSender, telegramConfig, registerTelegram } from '../apps/api/src/channels.js';
import Fastify from 'fastify';
import type { PrismaPersistence } from '../apps/api/src/persistence.js';

const config = { enabled: true, ownerId: '12345', token: '123:synthetic-not-a-real-telegram-token', webhookSecret: 'synthetic-webhook-secret' };
test('channel is disabled by default and incomplete private configuration is rejected', () => {
  assert.equal(telegramConfig({}).enabled, false);
  assert.throws(() => telegramConfig({ TELEGRAM_ENABLED: 'true' }));
});
test('Telegram sender denies any recipient besides the verified owner', async () => {
  let calls = 0;
  const sender = new TelegramSender(config, async () => { calls++; throw new Error('No network expected'); });
  assert.equal((await sender.sendText('999', 'hello', new AbortController().signal)).status, 'failed');
  assert.equal(calls, 0);
});
test('Telegram API acceptance is not mislabeled as delivered and ambiguous errors are not retried', async () => {
  let calls = 0;
  const sender = new TelegramSender(config, async () => { calls++; return Response.json({ ok: true, result: { message_id: 9 } }); });
  assert.deepEqual(await sender.sendText('12345', 'hello', new AbortController().signal), { status: 'accepted', providerId: '9' });
  assert.equal(calls, 1);
  const uncertain = new TelegramSender(config, async () => { throw new Error('timeout'); });
  assert.equal((await uncertain.sendText('12345', 'hello', new AbortController().signal)).status, 'unknown');
});

test('a definitely rejected webhook reply retries the cached reply without repeating the note write', async () => {
  const server = Fastify(); let writes = 0, sends = 0;
  const store = { async createNote(input: { text: string }) { writes++; return { id: 'note', text: input.text }; } } as unknown as PrismaPersistence;
  const sender = { async sendText() { sends++; return sends === 1 ? { status: 'retryable', errorCode: 'RATE_LIMITED' } : { status: 'accepted' }; } } as unknown as TelegramSender;
  registerTelegram(server, config, store, sender, async () => 'unused');
  const request = { method: 'POST' as const, url: '/kari/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': config.webhookSecret }, payload: { update_id: 1, message: { message_id: 1, date: Math.floor(Date.now()/1000), from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text: '/note example' } } };
  assert.equal((await server.inject(request)).statusCode, 503);
  assert.equal((await server.inject(request)).statusCode, 200);
  assert.equal((await server.inject(request)).json().status, 'duplicate');
  assert.equal(writes, 1); assert.equal(sends, 2);
  await server.close();
});

test('uncertain webhook delivery is never replayed and unrelated identities cannot trigger owner chat', async () => {
  const server = Fastify(); let chats = 0, sends = 0;
  const sender = { async sendText() { sends++; return { status: 'unknown', errorCode: 'TIMEOUT' }; } } as unknown as TelegramSender;
  registerTelegram(server, config, {} as PrismaPersistence, sender, async () => { chats++; return 'hello'; });
  const request = { method: 'POST' as const, url: '/kari/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': config.webhookSecret }, payload: { update_id: 2, message: { message_id: 2, date: Math.floor(Date.now()/1000), from: { id: 12345 }, chat: { id: 12345, type: 'private' }, text: 'hello' } } };
  assert.equal((await server.inject(request)).statusCode, 200);
  assert.equal((await server.inject(request)).json().status, 'duplicate');
  assert.equal(chats, 1); assert.equal(sends, 1);
  const stranger = structuredClone(request); stranger.payload.update_id=3; stranger.payload.message.from.id=987;
  assert.equal((await server.inject(stranger)).json().status, 'ignored');
  assert.equal(chats, 1);
  await server.close();
});

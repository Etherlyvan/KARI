import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReminderScheduler, deliveryUpdate } from '../apps/api/src/scheduler.js';
import { handleTelegramUpdate, parseReminderDate } from '../apps/api/src/owner.js';
import type { OwnerStore, ReminderRecord, ReminderStore, ReminderUpdate } from '../apps/api/src/persistence.js';

const time = new Date('2026-11-05T02:00:00Z');
function reminder(id = 'r1'): ReminderRecord {
  return { id, ownerId: '123', text: 'Review CV', channel: 'telegram', recipient: '123',
    dueAt: time, expiresAt: new Date(time.getTime() + 15 * 60000), status: 'claimed',
    attempts: 1, nextAttemptAt: time, leaseId: `lease-${id}`, leaseUntil: new Date(time.getTime() + 60000) };
}
class FakeStore implements ReminderStore {
  readonly done: { id: string; update: ReminderUpdate }[] = [];
  constructor(public queue: ReminderRecord[]) {}
  async claimDue(_now: Date, limit = 20) { return this.queue.splice(0, limit); }
  async isClaimActive() { return true; }
  async finishReminder(id: string, _lease: string, update: ReminderUpdate) { this.done.push({ id, update }); }
}

test('scheduler is bounded to twenty serial deliveries with no extra work', async () => {
  const store = new FakeStore(Array.from({ length: 21 }, (_, i) => reminder(`r${i}`)));
  let inFlight = 0, peak = 0;
  const scheduler = new ReminderScheduler({ store, clock: () => time, sender: { async send() {
    inFlight++; peak = Math.max(peak, inFlight); await Promise.resolve(); inFlight--;
    return { status: 'accepted', providerId: 'provider-id' };
  } } });
  await scheduler.tick();
  assert.equal(peak, 1); assert.equal(store.done.length, 20); assert.equal(store.queue.length, 1);
  assert.ok(store.done.every(item => item.update.status === 'accepted'));
});

test('unknown network outcome is retained, never classified retryable', async () => {
  const store = new FakeStore([reminder()]);
  await new ReminderScheduler({ store, clock: () => time, sender: { async send() { throw new Error('socket reset'); } } }).tick();
  assert.deepEqual(store.done[0]?.update, { status: 'unknown', errorCode: 'DELIVERY_OUTCOME_UNKNOWN' });
});

test('explicit safe retries respect backoff, maximum attempts and relevance expiry', () => {
  const record = reminder();
  assert.equal(deliveryUpdate(record, { status: 'retryable', errorCode: 'NOT_ACCEPTED' }, time).nextAttemptAt?.getTime(), time.getTime() + 60000);
  assert.equal(deliveryUpdate({ ...record, attempts: 4 }, { status: 'retryable', errorCode: 'NOT_ACCEPTED' }, time).status, 'failed');
  assert.equal(deliveryUpdate({ ...record, expiresAt: new Date(time.getTime() + 60000) }, { status: 'retryable', errorCode: 'NOT_ACCEPTED' }, time).status, 'failed');
});

test('cancellation/lease loss prevents invoking the outbound adapter', async () => {
  const store = new FakeStore([reminder()]); store.isClaimActive = async () => false;
  let sent = false;
  await new ReminderScheduler({ store, clock: () => time, sender: { async send() { sent = true; return { status: 'delivered' }; } } }).tick();
  assert.equal(sent, false); assert.equal(store.done.length, 0);
});

test('owner identity and private chat gate all storage operations; failed commit is not called success', async () => {
  const secret = 'test-secret-not-an-actual-key'; let writes = 0;
  const store = { async createNote() { writes++; throw new Error('database unavailable'); } } as unknown as OwnerStore;
  const update = { message: { message_id: 99, date: time.getTime() / 1000, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/note Test' } };
  const options = { ownerId: '123', webhookSecret: secret, receivedSecret: secret, store, now: time };
  await assert.rejects(handleTelegramUpdate(update, { ...options, receivedSecret: 'wrong' }), { code: 'WEBHOOK_UNAUTHORIZED' });
  assert.equal(await handleTelegramUpdate(update, { ...options, ownerId: '999' }), null);
  assert.equal(await handleTelegramUpdate({ message: { ...update.message, chat: { id: 123, type: 'group' } } }, options), null);
  assert.equal(writes, 0);
  const result = await handleTelegramUpdate(update, options);
  assert.equal(writes, 1); assert.match(result!.text, /belum bisa dipastikan berhasil/u);
});

test('reminder parser requires explicit offset and rejects rolled calendar dates', () => {
  assert.equal(parseReminderDate('2026-11-05T09:00+07:00')?.toISOString(), '2026-11-05T02:00:00.000Z');
  assert.equal(parseReminderDate('2026-11-05T09:00'), null);
  assert.equal(parseReminderDate('2026-02-30T09:00+07:00'), null);
  assert.equal(parseReminderDate('2026-11-05T09:00+14:30'), null);
});

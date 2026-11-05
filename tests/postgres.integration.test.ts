import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaPersistence, reservationBuckets, type SpendingLimits } from '../apps/api/src/persistence.js';

const databaseUrl = process.env.KARI_TEST_DATABASE_URL;

test('PostgreSQL: durable budgets, owner isolation and lease recovery', { skip: !databaseUrl }, async t => {
  // claimDue is deliberately global. Never let this suite claim application reminders.
  const url = new URL(databaseUrl!);
  assert.equal(url.pathname, '/kari_test', 'KARI_TEST_DATABASE_URL must name the dedicated kari_test database.');
  const tag = randomUUID();
  const model = `integration-${tag}`;
  const ownerA = `91${Date.now()}`;
  const ownerB = `92${Date.now()}`;
  const limits: SpendingLimits = {
    dailyMicroUsd: 100n, monthlyMicroUsd: 1000n,
    models: { [model]: { dailyMicroUsd: 100n, monthlyMicroUsd: 1000n } },
  };
  const accountingTime = new Date('2088-03-05T00:00:00Z');
  const bucketIds = reservationBuckets(model, 60n, accountingTime, limits).map(bucket => bucket.id);
  const reservationIds = ['first', 'second', 'unknown', 'blocked', 'explicit-blocked'].map(name => `pg-${tag}-${name}`);
  let store = new PrismaPersistence(databaseUrl!, limits);
  let ownedBlockReason: string | undefined;
  t.after(async () => {
    // Delete only records this suite created; no TRUNCATE or broad application cleanup.
    await store.client.reminder.deleteMany({ where: { ownerId: { in: [ownerA, ownerB] } } });
    await store.client.note.deleteMany({ where: { ownerId: { in: [ownerA, ownerB] } } });
    await store.client.spendReservation.deleteMany({ where: { id: { in: reservationIds } } });
    await store.client.spendBucket.deleteMany({ where: { id: { in: bucketIds } } });
    if (ownedBlockReason) await store.client.financialState.deleteMany({ where: { id: 'inference', blockedReason: ownedBlockReason } });
    await store.close();
  });

  await t.test('concurrent worst-case reservations cannot both pass a shared ceiling', async () => {
    const results = await Promise.allSettled(reservationIds.slice(0, 2).map(id => store.reserve({
      id, model, maxMicroUsd: 60n, now: accountingTime,
    })));
    const admitted = results.filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(admitted.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.reason.code, 'BUDGET_EXHAUSTED');
    const reservationId = admitted[0]!.value;
    let buckets = await store.client.spendBucket.findMany({ where: { id: { in: bucketIds } } });
    assert.equal(buckets.length, 4);
    assert.ok(buckets.every(bucket => bucket.usedMicroUsd === 60n));

    // Racing duplicate settlement refunds once, never once per caller.
    await Promise.all([store.settle(reservationId, 20n), store.settle(reservationId, 20n)]);
    buckets = await store.client.spendBucket.findMany({ where: { id: { in: bucketIds } } });
    assert.ok(buckets.every(bucket => bucket.usedMicroUsd === 20n));
    await assert.rejects(store.settle(reservationId, 21n), { code: 'SETTLEMENT_CONFLICT' });
    await assert.rejects(store.reserve({ id: reservationId, model, maxMicroUsd: 60n, now: accountingTime }), { code: 'RESERVATION_EXISTS' });

    const unknownId = reservationIds[2]!;
    await store.reserve({ id: unknownId, model, maxMicroUsd: 30n, now: accountingTime });
    await store.settle(unknownId, undefined);
    await store.close();
    store = new PrismaPersistence(databaseUrl!, limits);
    const unknown = await store.client.spendReservation.findUniqueOrThrow({ where: { id: unknownId } });
    assert.equal(unknown.status, 'held');
    assert.equal(unknown.actualMicroUsd, null);
    buckets = await store.client.spendBucket.findMany({ where: { id: { in: bucketIds } } });
    assert.ok(buckets.every(bucket => bucket.usedMicroUsd === 50n), 'worst-case hold survives process/client recreation');
  });

  await t.test('note retries are idempotent and request IDs cannot reveal another owner note', async () => {
    const requestId = `note-${tag}`;
    const input = { ownerId: ownerA, requestId, text: 'Private synthetic note for owner A.' };
    const [first, retry] = await Promise.all([store.createNote(input), store.createNote(input)]);
    assert.equal(first.id, retry.id);
    assert.equal((await store.listNotes(ownerA)).length, 1);
    await assert.rejects(store.createNote({ ...input, ownerId: ownerB }), { code: 'REQUEST_CONFLICT' });
    await assert.rejects(store.createNote({ ...input, text: 'Different request contents' }), { code: 'REQUEST_CONFLICT' });
    assert.deepEqual(await store.listNotes(ownerB), []);
    await store.createNote({ ownerId: ownerB, requestId: `note-other-${tag}`, text: 'Private synthetic note for owner B.' });
    assert.deepEqual((await store.listNotes(ownerA)).map(note => note.id), [first.id]);
    assert.ok((await store.listNotes(ownerB)).every(note => note.ownerId === ownerB));
  });

  await t.test('claims are exclusive and expired sending leases become unknown after restart', async () => {
    const createdAt = new Date('2089-04-06T00:00:00Z');
    const dueAt = new Date(createdAt.getTime() + 1000);
    const input = { ownerId: ownerA, text: 'Synthetic reminder; no adapter will be called.',
      channel: 'telegram' as const, recipient: ownerA, dueAt, now: createdAt };
    const first = await store.createReminder({ ...input, requestId: `reminder-first-${tag}` });
    const duplicate = await store.createReminder({ ...input, requestId: `reminder-first-${tag}` });
    assert.equal(first.id, duplicate.id);
    const second = await store.createReminder({ ...input, requestId: `reminder-second-${tag}` });
    await assert.rejects(store.createReminder({ ...input, ownerId: ownerB, recipient: ownerB, requestId: `reminder-first-${tag}` }), { code: 'REQUEST_CONFLICT' });
    await assert.rejects(store.createReminder({ ...input, recipient: ownerB, requestId: `reminder-wrong-recipient-${tag}` }), { code: 'INVALID_RECIPIENT' });
    const claims = (await Promise.all([store.claimDue(dueAt, 1), store.claimDue(dueAt, 1)])).flat();
    assert.deepEqual(new Set(claims.map(row => row.id)), new Set([first.id, second.id]));
    assert.ok(claims.every(row => row.attempts === 1 && !!row.leaseId));
    assert.notEqual(claims[0]!.leaseId, claims[1]!.leaseId);
    assert.equal(await store.isClaimActive(claims[0]!.id, claims[0]!.leaseId!, dueAt), true);
    assert.equal(await store.cancelReminder(ownerA, first.id), false, 'do not promise cancellation after sending claim');

    await store.close();
    store = new PrismaPersistence(databaseUrl!, limits);
    const recoveredAt = new Date(dueAt.getTime() + 60001);
    assert.deepEqual(await store.claimDue(recoveredAt), []);
    const recovered = await store.client.reminder.findMany({ where: { id: { in: [first.id, second.id] } } });
    assert.ok(recovered.every(row => row.status === 'unknown' && row.attempts === 1 && row.leaseId === null));
    await store.finishReminder(first.id, claims.find(row => row.id === first.id)!.leaseId!, { status: 'accepted', providerId: 'late-result' });
    assert.equal((await store.client.reminder.findUniqueOrThrow({ where: { id: first.id } })).status, 'unknown', 'stale lease must not overwrite recovery state');

    const pending = await store.createReminder({ ...input, requestId: `reminder-pending-${tag}`, dueAt: new Date(dueAt.getTime() + 3600000) });
    assert.equal(await store.cancelReminder(ownerB, pending.id), false);
    assert.equal(await store.cancelReminder(ownerA, pending.id), true);
    assert.equal(await store.cancelReminder(ownerA, pending.id), false);
    assert.equal((await store.client.reminder.findUniqueOrThrow({ where: { id: pending.id } })).status, 'cancelled');
  });

  await t.test('known overage is accounted and blocks every future path across client restart', async () => {
    ownedBlockReason = 'Billed usage exceeded reserved maximum.';
    await assert.rejects(store.settle(reservationIds[2]!, 41n), { code: 'ACCOUNTING_BLOCKED' });
    const settled = await store.client.spendReservation.findUniqueOrThrow({ where: { id: reservationIds[2]! } });
    assert.equal(settled.actualMicroUsd, 41n);
    assert.equal(settled.status, 'settled');
    const counters = await store.client.spendBucket.findMany({ where: { id: { in: bucketIds } } });
    assert.ok(counters.every(bucket => bucket.usedMicroUsd === 61n), 'actual overage must not disappear from counters');
    await store.close();
    store = new PrismaPersistence(databaseUrl!, limits);
    await assert.rejects(store.reserve({ id: reservationIds[3]!, model, maxMicroUsd: 1n, now: accountingTime }), { code: 'ACCOUNTING_BLOCKED' });
    await store.client.financialState.delete({ where: { id: 'inference' } }); // Explicit operator reset simulated by test only.
    ownedBlockReason = undefined;
  });

  await t.test('unpriced contract mismatch has a durable explicit block without invented usage', async () => {
    ownedBlockReason = `INTEGRATION_${tag.replaceAll('-', '').toUpperCase()}`;
    const before = await store.client.spendBucket.findMany({ where: { id: { in: bucketIds } }, orderBy: { id: 'asc' } });
    await store.block(ownedBlockReason);
    await store.close();
    store = new PrismaPersistence(databaseUrl!, limits);
    await assert.rejects(store.reserve({ id: reservationIds[4]!, model, maxMicroUsd: 1n, now: accountingTime }), { code: 'ACCOUNTING_BLOCKED' });
    const after = await store.client.spendBucket.findMany({ where: { id: { in: bucketIds } }, orderBy: { id: 'asc' } });
    assert.deepEqual(after, before, 'blocking an unknown model/contract must not fabricate a bill');
  });
});

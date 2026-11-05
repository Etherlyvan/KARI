import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnerChat } from '../apps/api/src/owner-chat.js';
import { loadConfig } from '../apps/api/src/config.js';
import type { SpendingStore } from '../apps/api/src/persistence.js';

const input = (message: string, requestId = 'message-1') => ({ ownerId: '123456', requestId, message });
function enabledConfig() { return loadConfig({ AI_ENABLED: 'true', AI_CAPABILITIES_VERIFIED: 'true', AI_API_KEY: 'synthetic-test-key' }); }
function fakeStore() {
  const reservations: { id: string; maxMicroUsd: bigint }[] = [];
  const settlements: { id: string; actual?: bigint }[] = [];
  const store: SpendingStore = {
    async reserve(request) { reservations.push(request); return request.id; },
    async settle(id, actual) { settlements.push({ id, actual }); },
  };
  return { reservations, settlements, store };
}
const response = (content = 'Tentu, Jovan. Kita bisa bahas idemu pelan-pelan 😉') => new Response(JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));

test('owner greeting/help are local and disabled free chat is honest', async () => {
  let calls = 0;
  const chat = createOwnerChat({ config: loadConfig({}), fetch: async () => { calls++; throw new Error('must stay local'); } });
  assert.match(await chat(input('halo', 'greet')), /Jovan/u);
  assert.match(await chat(input('/help', 'help')), /\/note/u);
  assert.match(await chat(input('Aku ingin cerita tentang hari ini', 'free')), /belum diaktifkan/u);
  assert.equal(calls, 0);
  await assert.rejects(chat({ ownerId: 'public-user', requestId: 'invalid', message: 'halo' }));
});

test('paid owner reply needs verification, key, durable admission and shared capacity', async () => {
  let calls = 0, acquisitions = 0;
  const unavailable = createOwnerChat({ config: enabledConfig(), fetch: async () => { calls++; return response(); } });
  assert.match(await unavailable(input('Aku sedang mengerjakan ide baru')), /tidak tersedia/u);
  const { store } = fakeStore();
  const full = createOwnerChat({ config: enabledConfig(), persistence: store, acquireInference: () => { acquisitions++; return undefined; }, fetch: async () => { calls++; return response(); } });
  assert.match(await full(input('Aku sedang mengerjakan ide baru')), /sibuk/u);
  const unverified = enabledConfig(); unverified.ai.verified = false;
  assert.match(await createOwnerChat({ config: unverified, persistence: store, fetch: async () => { calls++; return response(); } })(input('Ada ide baru')), /tidak tersedia/u);
  assert.equal(calls, 0);
  assert.equal(acquisitions, 1);
});

test('single owner attempt has compact persona, no tools/context retrieval and replay-safe accounting', async () => {
  const { store, reservations, settlements } = fakeStore();
  let calls = 0, releases = 0;
  const chat = createOwnerChat({ config: enabledConfig(), persistence: store, acquireInference: () => () => { releases++; }, fetch: async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'deepseek-v4-flash'); assert.equal(body.max_tokens, 160); assert.equal(body.stream, false);
    assert.equal(body.tools, undefined); assert.equal(body.messages.length, 2);
    assert.match(body.messages[0].content, /jangan posesif/iu);
    assert.ok(Buffer.byteLength(JSON.stringify(body.messages), 'utf8') < 1000);
    return response();
  } });
  const request = input('Aku punya ide proyek baru');
  const first = await chat(request), replay = await chat(request);
  assert.equal(first, replay); assert.equal(calls, 1); assert.equal(releases, 1);
  assert.equal(reservations.length, 1); assert.equal(reservations[0]?.maxMicroUsd, 119n);
  assert.equal(settlements[0]?.actual, 18n);
  assert.match(await chat({ ...request, message: 'changed' }), /berbeda/u);
});

test('owner history is session-local, expires, and never mixes owner identities', async () => {
  const { store } = fakeStore();
  let date = new Date('2026-11-05T00:00:00Z');
  const sent: { role: string; content: string }[][] = [];
  const chat = createOwnerChat({ config: enabledConfig(), persistence: store, now: () => date, fetch: async (_url, init) => { sent.push(JSON.parse(String(init?.body)).messages); return response('Oke.'); } });
  await chat(input('Idenya sebuah aplikasi', 'first'));
  await chat(input('Bagaimana menurutmu?', 'second'));
  assert.equal(sent[1]?.length, 4);
  await chat({ ...input('Aku punya ide juga', 'other-owner'), ownerId: '999999' });
  assert.equal(sent[2]?.length, 2);
  date = new Date(date.getTime() + 31 * 60_000);
  await chat(input('Lanjut cerita lagi', 'later'));
  assert.equal(sent[3]?.length, 2);
});

test('budget failure and uncertain response preserve funds with no automatic retry', async () => {
  const { store, reservations, settlements } = fakeStore();
  let calls = 0, releases = 0;
  const chat = createOwnerChat({ config: enabledConfig(), persistence: store, acquireInference: () => () => { releases++; }, fetch: async () => { calls++; throw new TypeError('synthetic network failure'); } });
  await chat(input('Aku ingin bercerita'));
  await chat(input('Aku ingin bercerita'));
  assert.equal(calls, 1); assert.equal(releases, 1); assert.equal(reservations.length, 1);
  assert.deepEqual(settlements.map(item => item.actual), [undefined]);
  const rejected = createOwnerChat({ config: enabledConfig(), persistence: { reserve: async () => { throw new Error('limit'); }, settle: async () => {} }, fetch: async () => { calls++; return response(); } });
  await rejected(input('Ada cerita baru'));
  assert.equal(calls, 1);
});

test('owner daily chat cap survives idle-history expiry', async () => {
  let date = new Date('2026-11-05T00:00:00Z');
  const chat = createOwnerChat({ config: loadConfig({}), now: () => date });
  for (let i = 0; i < 40; i++) {
    if (i % 20 === 0) date = new Date(date.getTime() + 31 * 60_000);
    assert.doesNotMatch(await chat(input('halo', `hello-${i}`)), /Batas/u);
  }
  assert.match(await chat(input('halo', 'limit')), /Batas/u);
});

test('oversized messages and invalid expensive served models do not pass unnoticed', async () => {
  const { store, settlements } = fakeStore(); let calls = 0;
  const chat = createOwnerChat({ config: enabledConfig(), persistence: store, fetch: async () => { calls++; return new Response(JSON.stringify({ model: 'gpt-6-astra', choices: [{ message: { content: 'wrong model' } }] })); } });
  assert.match(await chat(input('界'.repeat(500), 'oversize')), /singkat/u);
  await chat(input('Ada ide baru', 'bad-model'));
  await chat(input('Ide lain', 'next'));
  assert.equal(calls, 1); assert.deepEqual(settlements.map(item => item.actual), [undefined]);
});

test('known owner usage settles actual overage before durable block and unavailable reply', async () => {
  const events: string[] = [];
  const chat = createOwnerChat({ config: enabledConfig(), persistence: {
    reserve: async () => { events.push('reserve'); return 'owner-reservation'; },
    settle: async (_id, actual) => {
      events.push(`settle:${String(actual)}`);
      if (actual !== undefined && actual > 119n) throw new Error('ACCOUNTING_BLOCKED after persistent overage');
    },
    block: async reason => { events.push(`block:${reason}`); },
  }, fetch: async () => new Response(JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ message: { content: 'Over-cap' } }], usage: { prompt_tokens: 3000, completion_tokens: 160 } })) });
  assert.match(await chat(input('Aku ingin ngobrol', 'owner-overage')), /tidak tersedia/u);
  assert.deepEqual(events.slice(0, 3), ['reserve', 'settle:299', 'block:PROVIDER_BUDGET_MISMATCH']);
});

test('invalid owner response blocks a fresh helper through the shared durable store', async () => {
  let blocked = false, calls = 0;
  const actuals: (bigint | undefined)[] = [];
  const persistence: SpendingStore = {
    reserve: async () => { if (blocked) throw new Error('ACCOUNTING_BLOCKED'); return 'reservation'; },
    settle: async (_id, actual) => { actuals.push(actual); },
    block: async () => { blocked = true; },
  };
  for (let process = 0; process < 2; process++) {
    const chat = createOwnerChat({ config: enabledConfig(), persistence, fetch: async () => { calls++; return new Response(JSON.stringify({ model: 'gpt-6-astra', choices: [] })); } });
    assert.match(await chat(input('Aku ingin bercerita', `different-process-${process}`)), /tidak tersedia/u);
  }
  assert.equal(blocked, true); assert.equal(calls, 1);
  assert.deepEqual(actuals, [undefined]);
});

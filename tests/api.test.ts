import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppOptions } from '../apps/api/src/app.js';
import { loadConfig } from '../apps/api/src/config.js';
import type { SpendingStore } from '../apps/api/src/persistence.js';

async function fixture(options: Partial<AppOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kari-api-test-'));
  const knowledgePath = join(directory, 'knowledge.json');
  await writeFile(knowledgePath, JSON.stringify({
    schemaVersion: 1, siteId: 'a', sourceOrigin: 'https://a.example', contentVersion: '0'.repeat(64),
    chunks: [
      { id: 'contact', href: '/#contact', text: 'Public contact: public@example.com. No CV is published.' },
      { id: 'project-genbatik', href: '/#projects', text: 'Genbatik: AI batik platform using FastAPI and ControlNet.' },
    ],
  }));
  const config = options.config ?? loadConfig({ KARI_SITES_JSON: JSON.stringify([
    { id: 'a', name: 'Website A', origins: ['https://a.example', 'https://second.example'], knowledgePath },
    { id: 'b', name: 'Website B', origins: ['https://b.example'] },
  ]) });
  const app = await createApp({ ...options, config });
  const server = app.getHttpAdapter().getInstance();
  const inject = server.inject.bind(server);
  return {
    app, inject, config, directory,
    async session(siteId = 'a', origin = 'https://a.example') {
      const response = await inject({ method: 'POST', url: '/kari/api/sessions', headers: { origin }, payload: { siteId } });
      assert.equal(response.statusCode, 201);
      return response.json().token as string;
    },
    async close() { await app.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('public local answers use zero inference and expose no owner fields', async () => {
  let fetchCalls = 0;
  const fx = await fixture({ fetch: async () => { fetchCalls++; throw new Error('must not call inference'); } });
  try {
    const token = await fx.session();
    const response = await fx.inject({ method: 'POST', url: '/kari/api/chat', headers: { origin: 'https://a.example', authorization: `Bearer ${token}` }, payload: { siteId: 'a', message: 'Apa kontak email?', requestId: 'local-contact-1' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().mode, 'local');
    assert.match(response.json().text, /public@example.com/u);
    assert.equal(fetchCalls, 0);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['access-control-allow-origin'], 'https://a.example');
    assert.equal(response.headers['set-cookie'], undefined);
  } finally { await fx.close(); }
});

test('sessions and tokens are bound to the registered site and exact origin', async () => {
  const fx = await fixture();
  try {
    const forbidden = await fx.inject({ method: 'POST', url: '/kari/api/sessions', headers: { origin: 'https://evil.example' }, payload: { siteId: 'a' } });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.headers['access-control-allow-origin'], undefined);
    const noOrigin = await fx.inject({ method: 'POST', url: '/kari/api/sessions', payload: { siteId: 'a' } });
    assert.equal(noOrigin.statusCode, 403);
    const token = await fx.session();
    for (const [siteId, origin] of [['b', 'https://b.example'], ['a', 'https://second.example']]) {
      const response = await fx.inject({ method: 'POST', url: '/kari/api/chat', headers: { origin, authorization: `Bearer ${token}` }, payload: { siteId, message: 'halo', requestId: 'cross-site-0001' } });
      assert.equal(response.statusCode, 401);
    }
    const noToken = await fx.inject({ method: 'POST', url: '/kari/api/chat', headers: { origin: 'https://a.example' }, payload: { siteId: 'a', message: 'halo', requestId: 'no-token-0001' } });
    assert.equal(noToken.statusCode, 401);
  } finally { await fx.close(); }
});

test('CORS preflight admits only exact configured origins, no credential wildcard', async () => {
  const fx = await fixture();
  try {
    const response = await fx.inject({ method: 'OPTIONS', url: '/kari/api/chat', headers: { origin: 'https://a.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], 'https://a.example');
    assert.equal(response.headers['access-control-allow-credentials'], undefined);
    assert.equal((await fx.inject({ method: 'OPTIONS', url: '/kari/api/chat', headers: { origin: 'https://a.example.evil.example' } })).statusCode, 403);
  } finally { await fx.close(); }
});

test('rejects owner/model injection, oversized UTF-8 messages and expired sessions', async () => {
  let clock = new Date('2026-11-05T00:00:00Z');
  const fx = await fixture({ now: () => clock });
  try {
    const token = await fx.session();
    const headers = { origin: 'https://a.example', authorization: `Bearer ${token}` };
    assert.equal((await fx.inject({ method: 'POST', url: '/kari/api/chat', headers, payload: { siteId: 'a', message: 'halo', requestId: 'owner-injection', model: 'auto', mode: 'owner' } })).statusCode, 400);
    assert.equal((await fx.inject({ method: 'POST', url: '/kari/api/chat', headers, payload: { siteId: 'a', message: '界'.repeat(500), requestId: 'large-message-1' } })).statusCode, 400);
    clock = new Date(clock.getTime() + 31 * 60_000);
    assert.equal((await fx.inject({ method: 'POST', url: '/kari/api/chat', headers, payload: { siteId: 'a', message: 'halo', requestId: 'expired-token-1' } })).statusCode, 401);
  } finally { await fx.close(); }
});

test('AI fails closed without durable spending admission', async () => {
  let calls = 0;
  const config = loadConfig({ AI_ENABLED: 'true', AI_CAPABILITIES_VERIFIED: 'true', AI_API_KEY: 'synthetic-test-key', KARI_SITES_JSON: JSON.stringify([{ id: 'a', name: 'Website A', origins: ['https://a.example'] }]) });
  const fx = await fixture({ fetch: async () => { calls++; throw new Error('unexpected inference'); } });
  try {
    fx.config.ai = config.ai;
    const token = await fx.session();
    const response = await fx.inject({ method: 'POST', url: '/kari/api/chat', headers: { origin: 'https://a.example', authorization: `Bearer ${token}` }, payload: { siteId: 'a', message: 'Compare Genbatik architecture', requestId: 'budget-closed-1' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'ACCOUNTING_UNAVAILABLE');
    assert.equal(calls, 0);
  } finally { await fx.close(); }
});

test('one paid attempt, atomic admission, bounded usage settlement and duplicate replay', async () => {
  const reservations: unknown[] = [], settlements: unknown[] = [];
  let calls = 0;
  const persistence: SpendingStore = {
    async reserve(input) { reservations.push(input); return input.id; },
    async settle(id, amount) { settlements.push({ id, amount }); },
  };
  const fx = await fixture({ persistence, fetch: async (_url, request) => {
    calls++;
    const payload = JSON.parse(String(request?.body));
    assert.equal(payload.model, 'deepseek-v4-flash');
    assert.equal(payload.max_tokens, 300);
    assert.equal(payload.stream, false);
    return new Response(JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ message: { content: 'Only the published FastAPI and ControlNet details are verified.' } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }), { headers: { 'content-type': 'application/json' } });
  } });
  try {
    fx.config.ai = { enabled: true, verified: true, apiKey: 'synthetic-test-key', baseUrl: 'https://ai.yogathedev.com/v1', model: 'deepseek-v4-flash' };
    const token = await fx.session();
    const request = { method: 'POST' as const, url: '/kari/api/chat', headers: { origin: 'https://a.example', authorization: `Bearer ${token}` }, payload: { siteId: 'a', message: 'Compare Genbatik architecture', requestId: 'paid-duplicate-1' } };
    const first = await fx.inject(request), duplicate = await fx.inject(request);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().mode, 'ai');
    assert.deepEqual(duplicate.json(), first.json());
    assert.equal(calls, 1);
    assert.equal(reservations.length, 1);
    assert.equal(settlements.length, 1);
    assert.equal((settlements[0] as { amount: bigint }).amount, 27n);
    const conflict = await fx.inject({ ...request, payload: { ...request.payload, message: 'different' } });
    assert.equal(conflict.statusCode, 409);
  } finally { await fx.close(); }
});

test('database/budget refusal never calls provider', async () => {
  let calls = 0;
  const fx = await fixture({ persistence: { reserve: async () => { throw new Error('budget exhausted'); }, settle: async () => {} }, fetch: async () => { calls++; throw new Error('unexpected'); } });
  try {
    fx.config.ai = { ...fx.config.ai, enabled: true, verified: true, apiKey: 'synthetic-test-key' };
    const token = await fx.session();
    const response = await fx.inject({ method: 'POST', url: '/kari/api/chat', headers: { origin: 'https://a.example', authorization: `Bearer ${token}` }, payload: { siteId: 'a', message: 'Compare Genbatik architecture', requestId: 'refused-budget-1' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'BUDGET_UNAVAILABLE');
    assert.equal(calls, 0);
  } finally { await fx.close(); }
});

test('static serving is public-module compatible and excludes traversal or unknown files', async () => {
  const widgetDir = await mkdtemp(join(tmpdir(), 'kari-widget-test-'));
  await mkdir(join(widgetDir, 'assets'));
  await writeFile(join(widgetDir, 'embed.js'), 'export const publicWidget = true;');
  await writeFile(join(widgetDir, 'secret.txt'), 'never public');
  const fx = await fixture({ widgetDir });
  try {
    const asset = await fx.inject({ method: 'GET', url: '/kari/embed.js', headers: { origin: 'https://any-host.example' } });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers['content-type'], /javascript/u);
    assert.equal(asset.headers['access-control-allow-origin'], '*');
    assert.equal((await fx.inject({ method: 'GET', url: '/kari/secret.txt' })).statusCode, 404);
    assert.equal((await fx.inject({ method: 'GET', url: '/kari/../package.json' })).statusCode, 404);
    assert.equal((await fx.inject({ method: 'GET', url: '/kari/api/unknown' })).statusCode, 404);
    assert.equal((await fx.inject({ method: 'GET', url: '/kari/api/health' })).statusCode, 200);
  } finally { await fx.close(); await rm(widgetDir, { recursive: true, force: true }); }
});

test('HTTP body and per-session attempt limits are enforced before expensive work', async () => {
  let calls = 0;
  const fx = await fixture({ fetch: async () => { calls++; throw new Error('must stay local'); } });
  try {
    const token = await fx.session();
    const headers = { origin: 'https://a.example', authorization: `Bearer ${token}` };
    const large = await fx.inject({ method: 'POST', url: '/kari/api/chat', headers, payload: { siteId: 'a', message: 'x'.repeat(10_000), requestId: 'large-body-test' } });
    assert.equal(large.statusCode, 413);
    for (let index = 0; index < 5; index++) {
      const result = await fx.inject({ method: 'POST', url: '/kari/api/chat', headers, payload: { siteId: 'a', message: 'halo', requestId: `session-limit-${index}` } });
      assert.equal(result.statusCode, 200);
    }
    const limited = await fx.inject({ method: 'POST', url: '/kari/api/chat', headers, payload: { siteId: 'a', message: 'halo', requestId: 'session-limit-last' } });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['retry-after'], '60');
    assert.equal(calls, 0);
  } finally { await fx.close(); }
});

test('uncertain provider failures retain full cost and duplicate errors do not retry', async () => {
  let calls = 0;
  const settled: (bigint | undefined)[] = [];
  const fx = await fixture({ persistence: { reserve: async input => input.id, settle: async (_id, amount) => { settled.push(amount); } }, fetch: async () => { calls++; throw new TypeError('synthetic disconnect'); } });
  try {
    fx.config.ai = { ...fx.config.ai, enabled: true, verified: true, apiKey: 'synthetic-test-key' };
    const token = await fx.session();
    const request = { method: 'POST' as const, url: '/kari/api/chat', headers: { origin: 'https://a.example', authorization: `Bearer ${token}` }, payload: { siteId: 'a', message: 'Compare Genbatik architecture', requestId: 'unknown-outcome-1' } };
    const first = await fx.inject(request), repeat = await fx.inject(request);
    assert.equal(first.statusCode, 503);
    assert.deepEqual(repeat.json(), first.json());
    assert.equal(calls, 1);
    assert.deepEqual(settled, [undefined]);
  } finally { await fx.close(); }
});

test('model substitution blocks further paid requests instead of expensive fallback', async () => {
  let calls = 0;
  const fx = await fixture({ persistence: { reserve: async input => input.id, settle: async () => {} }, fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ model: 'expensive-substitute', choices: [{ message: { content: 'unsafe routing' } }] }));
  } });
  try {
    fx.config.ai = { ...fx.config.ai, enabled: true, verified: true, apiKey: 'synthetic-test-key' };
    const token = await fx.session();
    const request = { method: 'POST' as const, url: '/kari/api/chat', headers: { origin: 'https://a.example', authorization: `Bearer ${token}` }, payload: { siteId: 'a', message: 'Compare Genbatik architecture', requestId: 'model-mismatch-1' } };
    const first = await fx.inject(request);
    assert.equal(first.statusCode, 502);
    const next = await fx.inject({ ...request, payload: { ...request.payload, requestId: 'model-mismatch-2' } });
    assert.equal(next.statusCode, 503);
    assert.equal(next.json().error, 'PROVIDER_CIRCUIT_OPEN');
    assert.equal(calls, 1);
  } finally { await fx.close(); }
});

test('known public overage is accounted before a durable global block, including settlement exceptions', async () => {
  for (const usage of [{ prompt_tokens: 5000, completion_tokens: 300 }, { prompt_tokens: 2001, completion_tokens: 0 }]) {
    const events: string[] = [];
    const expected = (BigInt(usage.prompt_tokens) * 9n + BigInt(usage.completion_tokens) * 18n + 99n) / 100n;
    const fx = await fixture({ persistence: {
      reserve: async () => { events.push('reserve'); return 'reservation'; },
      settle: async (_id, actual) => {
        events.push(`settle:${String(actual)}`);
        if (actual !== undefined && actual > 234n) throw new Error('ACCOUNTING_BLOCKED after persisting overage');
      },
      block: async reason => { events.push(`block:${reason}`); },
    }, fetch: async () => new Response(JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ message: { content: 'Over-cap reply' } }], usage })) });
    try {
      fx.config.ai = { ...fx.config.ai, enabled: true, verified: true, apiKey: 'synthetic-key' };
      const token = await fx.session();
      const reply = await fx.inject({ method: 'POST', url: '/kari/api/chat', headers: { origin: 'https://a.example', authorization: `Bearer ${token}` }, payload: { siteId: 'a', message: 'Compare Genbatik architecture', requestId: 'over-cap-0001' } });
      assert.equal(reply.statusCode, 502);
      assert.equal(reply.json().error, 'PROVIDER_BUDGET_MISMATCH');
      assert.deepEqual(events.slice(0, 3), ['reserve', `settle:${expected}`, 'block:PROVIDER_BUDGET_MISMATCH']);
    } finally { await fx.close(); }
  }
});

test('malformed public provider responses persist a cross-restart block without inventing actual cost', async () => {
  let blocked = false, calls = 0;
  const actuals: (bigint | undefined)[] = [];
  const store: SpendingStore = {
    reserve: async () => { if (blocked) throw new Error('ACCOUNTING_BLOCKED'); return 'reservation'; },
    settle: async (_id, amount) => { actuals.push(amount); },
    block: async () => { blocked = true; },
  };
  for (let process = 0; process < 2; process++) {
    const fx = await fixture({ persistence: store, fetch: async () => { calls++; return new Response('{invalid-json'); } });
    try {
      fx.config.ai = { ...fx.config.ai, enabled: true, verified: true, apiKey: 'synthetic-key' };
      const token = await fx.session();
      const reply = await fx.inject({ method: 'POST', url: '/kari/api/chat', headers: { origin: 'https://a.example', authorization: `Bearer ${token}` }, payload: { siteId: 'a', message: 'Compare Genbatik architecture', requestId: 'invalid-json-0001' } });
      assert.equal(reply.statusCode, process === 0 ? 502 : 503);
    } finally { await fx.close(); }
  }
  assert.equal(blocked, true); assert.equal(calls, 1);
  assert.deepEqual(actuals, [undefined]);
});

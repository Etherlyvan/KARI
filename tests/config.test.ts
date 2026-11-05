import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../apps/api/src/config.js';

test('safe defaults disable inference and preserve fixed provider/model', () => {
  const config = loadConfig({});
  assert.equal(config.ai.enabled, false);
  assert.equal(config.ai.verified, false);
  assert.equal(config.ai.baseUrl, 'https://ai.yogathedev.com/v1');
  assert.equal(config.ai.model, 'deepseek-v4-flash');
  assert.equal(config.sites[0]?.id, 'portfolio');
});

test('refuses paid routing without independent verification and a secret', () => {
  assert.throws(() => loadConfig({ AI_ENABLED: 'true' }), /verification/u);
  assert.throws(() => loadConfig({ AI_ENABLED: 'true', AI_CAPABILITIES_VERIFIED: 'true' }), /verification/u);
  assert.equal(loadConfig({ AI_ENABLED: 'true', AI_CAPABILITIES_VERIFIED: 'true', AI_API_KEY: 'synthetic-test-key' }).ai.enabled, true);
});

test('cannot change provider or request an unapproved expensive model', () => {
  assert.throws(() => loadConfig({ AI_BASE_URL: 'https://evil.example/v1' }), /approved/u);
  for (const model of ['auto', 'glm-5.3', 'gpt-6-astra', 'unknown']) assert.throws(() => loadConfig({ AI_DEFAULT_MODEL: model }), /economical/u);
  assert.throws(() => loadConfig({ AI_ENABLED: 'yes' }), /true or false/u);
});

test('sites require exact origins without wildcards, paths, credentials or duplicates', () => {
  for (const value of ['*', 'https://a.example/path', 'https://a.example/', 'https://user:pass@a.example', 'http://public.example', 'null']) {
    assert.throws(() => loadConfig({ KARI_SITES_JSON: JSON.stringify([{ id: 'test', name: 'Test', origins: [value] }]) }), /invalid/u);
  }
  assert.throws(() => loadConfig({ KARI_SITES_JSON: JSON.stringify([{ id: 'same', name: 'A', origins: ['https://a.example'] }, { id: 'same', name: 'B', origins: ['https://b.example'] }]) }), /unique/u);
  assert.throws(() => loadConfig({ KARI_SITES_JSON: 'not-json' }), /JSON/u);
});

test('proxy forwarding is disabled by default and requires explicit IP/CIDR configuration', () => {
  assert.deepEqual(loadConfig({}).trustedProxies, []);
  assert.deepEqual(loadConfig({ KARI_TRUSTED_PROXIES: '127.0.0.1,172.24.0.0/16' }).trustedProxies, ['127.0.0.1', '172.24.0.0/16']);
  for (const value of ['true', '*', 'evil.example', '127.0.0.1/99']) assert.throws(() => loadConfig({ KARI_TRUSTED_PROXIES: value }), /explicit/u);
});

import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { loadConfig, type ApiConfig } from './config.js';
import { loadKnowledge, localAnswer, retrieve, sourceFor, type Answer, type Knowledge } from './knowledge.js';
import { inferAnswer, InferenceError, type Turn } from './provider.js';
import type { SpendingStore } from './persistence.js';

@Module({})
class KariModule {}

interface Session {
  id: string; siteId: string; origin: string; expiresAt: number; active: boolean; history: Turn[]; bytes: number;
  requests: Map<string, { messageHash: string; status: number; body?: unknown }>;
}
interface RateWindow { minute: number; minuteCount: number; day: string; dayCount: number; touched: number; }
export interface AppOptions {
  config?: ApiConfig; persistence?: SpendingStore; fetch?: typeof globalThis.fetch;
  now?: () => Date; widgetDir?: string; logger?: boolean;
  registerRoutes?: (server: FastifyInstance) => void | Promise<void>;
  acquireInference?: () => (() => void) | undefined;
}
const sessionBody = z.object({ siteId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u) }).strict();
const chatBody = sessionBody.extend({
  message: z.string().trim().min(1).max(1200).refine(value => Buffer.byteLength(value, 'utf8') <= 1200),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/u),
}).strict();
const PUBLIC_PATHS = new Set(['/kari/api/sessions', '/kari/api/chat']);
const contentTypes: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.woff2': 'font/woff2' };

function fail(reply: FastifyReply, status: number, code: string, message = 'KARI belum bisa memproses permintaan ini. Coba lagi nanti.') {
  return reply.code(status).send({ error: code, message });
}

export async function createApp(options: AppOptions = {}): Promise<NestFastifyApplication> {
  const config = options.config ?? loadConfig();
  const now = options.now ?? (() => new Date());
  const fetch = options.fetch ?? globalThis.fetch;
  const logger = options.logger ? {
    level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'],
    serializers: { req: (req: { method?: string; url?: string }) => ({ method: req.method, path: req.url?.split('?')[0] }) },
  } : false;
  const adapter = new FastifyAdapter({ bodyLimit: 8 * 1024, logger, logController: new LogController({ disableRequestLogging: true }), trustProxy: config.trustedProxies.length ? config.trustedProxies : false });
  const app = await NestFactory.create<NestFastifyApplication>(KariModule, adapter, { logger: false });
  const server = adapter.getInstance();
  const knowledge = new Map<string, Knowledge>(await Promise.all(config.sites.map(async site => [site.id, await loadKnowledge(site)] as const)));
  const origins = new Set(config.sites.flatMap(site => site.origins));
  const sessions = new Map<string, Session>();
  const rates = new Map<string, RateWindow>();
  const salt = randomBytes(24).toString('hex');
  let upstreamActive = 0;
  let failures: number[] = [];
  let circuitUntil = 0;
  let providerBlocked = false;
  let sessionPayloadBytes = 0;
  const hash = (value: string) => createHash('sha256').update(`${salt}:${value}`).digest('hex');
  const jakartaDay = (date: Date) => new Date(date.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

  function cleanup(timestamp: number) {
    for (const [token, session] of sessions) if (session.expiresAt <= timestamp && !session.active) { sessions.delete(token); sessionPayloadBytes -= session.bytes; }
    for (const [key, rate] of rates) if (timestamp - rate.touched >= 24 * 3600_000) rates.delete(key);
  }
  function limited(key: string, perMinute: number, perDay: number, date: Date): boolean {
    const timestamp = date.getTime();
    const minute = Math.floor(timestamp / 60_000);
    const day = jakartaDay(date);
    let state = rates.get(key);
    if (!state) {
      if (rates.size >= 4000) return true;
      state = { minute, minuteCount: 0, day, dayCount: 0, touched: timestamp };
      rates.set(key, state);
    }
    if (state.minute !== minute) { state.minute = minute; state.minuteCount = 0; }
    if (state.day !== day) { state.day = day; state.dayCount = 0; }
    state.touched = timestamp;
    state.minuteCount++;
    state.dayCount++;
    return state.minuteCount > perMinute || state.dayCount > perDay;
  }
  const ipLimited = (request: FastifyRequest, date: Date) => limited(`ip:${jakartaDay(date)}:${hash(request.ip)}`, 20, 200, date);
  function accountSession(session: Session) {
    const bytes = Buffer.byteLength(JSON.stringify({ history: session.history, requests: [...session.requests] }), 'utf8');
    sessionPayloadBytes += bytes - session.bytes;
    session.bytes = bytes;
  }
  const siteFor = (siteId: string, origin: string | undefined) => config.sites.find(site => site.id === siteId && origin !== undefined && site.origins.includes(origin));

  server.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/kari/api/')) return;
    reply.header('Cache-Control', 'no-store');
    reply.header('Vary', 'Origin');
    if (!PUBLIC_PATHS.has(path)) return; // e.g. independently authenticated Telegram webhook
    const origin = request.headers.origin;
    if (!origin || !origins.has(origin)) return fail(reply, 403, 'ORIGIN_DENIED', 'Origin website belum diizinkan untuk KARI.');
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    reply.header('Access-Control-Max-Age', '600');
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });
  server.options('/kari/api/sessions', async (_request, reply) => reply.code(204).send());
  server.options('/kari/api/chat', async (_request, reply) => reply.code(204).send());
  server.get('/kari/api/health', async () => ({ status: 'ok', inference: config.ai.enabled && config.ai.verified && !!options.persistence && !providerBlocked ? 'configured' : 'disabled' }));

  server.post('/kari/api/sessions', async (request, reply) => {
    const date = now(); cleanup(date.getTime());
    if (limited('global', 60, 10_000, date) || limited('global-session', 30, 2000, date) || ipLimited(request, date)) {
      reply.header('Retry-After', '60'); return fail(reply, 429, 'RATE_LIMITED');
    }
    const parsed = sessionBody.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'INVALID_REQUEST');
    const site = siteFor(parsed.data.siteId, request.headers.origin);
    if (!site) return fail(reply, 403, 'SITE_DENIED');
    if (sessions.size >= 2000 || sessionPayloadBytes >= 32 * 1024 * 1024 - 64 * 1024) return fail(reply, 503, 'SESSION_CAPACITY');
    const token = randomBytes(32).toString('base64url');
    const session: Session = { id: randomBytes(16).toString('hex'), siteId: site.id, origin: request.headers.origin!, expiresAt: date.getTime() + 30 * 60_000, active: false, history: [], requests: new Map(), bytes: 0 };
    accountSession(session);
    sessions.set(hash(token), session);
    return reply.code(201).send({ token, expiresAt: new Date(session.expiresAt).toISOString() });
  });

  server.post('/kari/api/chat', async (request, reply) => {
    const date = now(); cleanup(date.getTime());
    if (limited('global', 60, 10_000, date) || ipLimited(request, date)) {
      reply.header('Retry-After', '60'); return fail(reply, 429, 'RATE_LIMITED');
    }
    const parsed = chatBody.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, 'INVALID_REQUEST');
    const { message, requestId, siteId } = parsed.data;
    const site = siteFor(siteId, request.headers.origin);
    if (!site) return fail(reply, 403, 'SITE_DENIED');
    const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1];
    const session = bearer ? sessions.get(hash(bearer)) : undefined;
    if (!session || session.siteId !== siteId || session.origin !== request.headers.origin || session.expiresAt <= date.getTime()) return fail(reply, 401, 'SESSION_REQUIRED');
    if (limited(`session:${session.id}`, 5, 40, date)) {
      reply.header('Retry-After', '60'); return fail(reply, 429, 'RATE_LIMITED');
    }
    const existing = session.requests.get(requestId);
    if (existing) {
      if (existing.messageHash !== hash(message)) return fail(reply, 409, 'REQUEST_ID_CONFLICT');
      if (!existing.body) return fail(reply, 409, 'REQUEST_IN_PROGRESS');
      return reply.code(existing.status).send(existing.body);
    }
    if (session.active) return fail(reply, 429, 'SESSION_BUSY');
    if (session.requests.size >= 40) return fail(reply, 429, 'SESSION_REQUEST_CAPACITY');
    if (sessionPayloadBytes >= 32 * 1024 * 1024 - 64 * 1024) return fail(reply, 503, 'SESSION_CAPACITY');
    const record: { messageHash: string; status: number; body?: unknown } = { messageHash: hash(message), status: 200 };
    session.requests.set(requestId, record);
    session.active = true;
    const abort = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) abort.abort(); };
    reply.raw.once('close', onClose);
    try {
      const facts = knowledge.get(siteId)!;
      let answer = localAnswer(message, site, facts);
      if (!answer) {
        if (!config.ai.enabled) {
          const chunks = retrieve(message, facts);
          answer = { text: chunks.map(chunk => chunk.text).join('\n\n').slice(0, 1600), sources: chunks.map(chunk => sourceFor(chunk, facts)), mode: 'local' };
        } else {
          if (providerBlocked || date.getTime() < circuitUntil) throw new InferenceError('PROVIDER_CIRCUIT_OPEN', 503);
          if (upstreamActive >= 4) throw new InferenceError('UPSTREAM_BUSY', 429);
          const release = options.acquireInference?.();
          if (options.acquireInference && !release) throw new InferenceError('UPSTREAM_BUSY', 429);
          upstreamActive++;
          try {
            answer = await inferAnswer({ message, site, knowledge: facts, history: session.history, config, persistence: options.persistence, fetch, reservationId: `public:${siteId}:${session.id}:${requestId}`, now: date, signal: abort.signal });
          } catch (error) {
            if (error instanceof InferenceError && error.code.startsWith('PROVIDER_')) {
              failures = failures.filter(timestamp => date.getTime() - timestamp < 60_000);
              failures.push(date.getTime());
              if (failures.length >= 3) circuitUntil = date.getTime() + 60_000;
              if (['PROVIDER_INVALID_RESPONSE', 'PROVIDER_BUDGET_MISMATCH'].includes(error.code)) providerBlocked = true;
            }
            throw error;
          } finally { upstreamActive--; release?.(); }
        }
      }
      session.history.push({ user: message, assistant: answer.text });
      session.history = session.history.slice(-2);
      record.body = answer;
      accountSession(session);
      request.log.info({ event: 'chat_complete', mode: answer.mode, siteId, requestId, sourceCount: answer.sources.length }, 'KARI request completed');
      return reply.send(answer);
    } catch (error) {
      const code = error instanceof InferenceError ? error.code : 'REQUEST_FAILED';
      const status = error instanceof InferenceError ? error.status : 503;
      record.status = status;
      record.body = { error: code, message: 'AI sementara tidak tersedia. Konten publik website tetap bisa digunakan.' };
      accountSession(session);
      request.log.warn({ event: 'chat_failed', code, siteId, requestId }, 'KARI request unavailable');
      return reply.code(status).send(record.body);
    } finally {
      session.active = false;
      reply.raw.off('close', onClose);
    }
  });

  const widgetDir = resolve(options.widgetDir ?? 'dist/widget');
  server.get('/kari/*', async (request, reply) => {
    const path = (request.params as { '*': string })['*'];
    if (!path || path.includes('..') || path.includes('\\') || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/u.test(path)) return fail(reply, 404, 'ASSET_NOT_FOUND');
    const mime = contentTypes[extname(path)];
    if (!mime || path.startsWith('api/')) return fail(reply, 404, 'ASSET_NOT_FOUND');
    try {
      const actualRoot = await realpath(widgetDir);
      const actualPath = await realpath(resolve(widgetDir, path));
      if (!actualPath.startsWith(actualRoot + sep)) return fail(reply, 404, 'ASSET_NOT_FOUND');
      const info = await stat(actualPath);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) return fail(reply, 404, 'ASSET_NOT_FOUND');
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Cache-Control', /[.-][a-f0-9]{8,}\./u.test(path) ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
      return reply.type(mime).send(await readFile(actualPath));
    } catch { return fail(reply, 404, 'ASSET_NOT_FOUND'); }
  });
  if (options.registerRoutes) await options.registerRoutes(server);
  await app.init();
  await server.ready();
  return app;
}

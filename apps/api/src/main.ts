import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPersistence } from './persistence.js';
import { createOwnerChat } from './owner-chat.js';
import { ReminderScheduler } from './scheduler.js';
import { TelegramSender, registerTelegram, telegramConfig } from './channels.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function main() {
  const config = loadConfig();
  const persistence = config.databaseUrl ? createPersistence(config.databaseUrl) : undefined;
  const telegram = telegramConfig();
  if (telegram.enabled && !persistence) throw new Error('Telegram private features require PostgreSQL.');
  let activeInference = 0;
  const acquireInference = () => {
    if (activeInference >= 4) return undefined;
    activeInference++; let released = false;
    return () => { if (!released) { released = true; activeInference--; } };
  };
  const ownerChat = createOwnerChat({ config, persistence, acquireInference });
  let scheduler: ReminderScheduler | undefined;
  let readyCache: { expires: number; ready: boolean } | undefined;
  let readyPending: Promise<boolean> | undefined;
  const app = await createApp({ config, persistence, logger: true, acquireInference, registerRoutes(server) {
    if (process.env.DEMO_ENABLED === 'true') {
      server.get('/', async (_req, reply) => reply.redirect('/demo/'));
      for (const [path, file] of [['/demo/', 'index.html'], ['/demo/second-site.html', 'second-site.html']]) {
        server.get(path!, async (_req, reply) => reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(await readFile(resolve('demo', file!))));
      }
    }
    server.get('/kari/api/ready', async (_req, reply) => {
      if (!persistence) return { status: 'local-only' };
      if (!readyCache || readyCache.expires <= Date.now()) {
        readyPending ??= persistence.client.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
        const ready = await readyPending;
        readyCache = { expires: Date.now() + 5000, ready }; readyPending = undefined;
      }
      return readyCache.ready ? { status: 'ready' } : reply.code(503).send({ status: 'database-unavailable' });
    });
    if (telegram.enabled && persistence) {
      const sender = new TelegramSender(telegram);
      registerTelegram(server, telegram, persistence, sender, ownerChat);
      scheduler = new ReminderScheduler({ store: persistence, sender, onError: code => server.log.warn({ code }, 'Reminder scheduler unavailable') });
    }
    server.addHook('onClose', async () => { await scheduler?.stop(); await persistence?.close(); });
  } });
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  scheduler?.start();
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('KARI startup failed. Check server configuration and database availability; credentials are intentionally omitted.');
    process.exitCode = 1;
  });
}

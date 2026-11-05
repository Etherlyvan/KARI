import { z } from 'zod';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

const siteId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const origin = z.string().refine(value => {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return value === url.origin && !url.username && !url.password &&
      (url.protocol === 'https:' || (local && url.protocol === 'http:'));
  } catch { return false; }
}, 'Expected an exact HTTPS origin (HTTP only on localhost).');
const siteSchema = z.object({
  id: siteId,
  origins: z.array(origin).min(1).max(20),
  name: z.string().min(1).max(100),
  knowledgePath: z.string().min(1).max(1000).optional(),
}).strict();

export type SiteConfig = z.infer<typeof siteSchema>;
export interface ApiConfig {
  host: string;
  port: number;
  sites: SiteConfig[];
  databaseUrl?: string;
  trustedProxies: string[];
  ai: { enabled: boolean; verified: boolean; baseUrl: string; apiKey?: string; model: 'deepseek-v4-flash'; };
}

function boolean(value: string | undefined, fallback: boolean, key: string): boolean {
  if (value === undefined) return fallback;
  if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false.`);
  return value === 'true';
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  let rawSites: unknown;
  try {
    rawSites = JSON.parse(env.KARI_SITES_JSON ?? JSON.stringify([{
      id: 'portfolio', name: 'Jovan portfolio',
      origins: ['http://localhost:4321', 'http://localhost:8080', 'http://localhost:3000', 'http://127.0.0.1:4321', 'http://127.0.0.1:8080', 'http://127.0.0.1:3000'],
      knowledgePath: 'data/portfolio.json',
    }]));
  } catch { throw new Error('KARI_SITES_JSON must be a JSON array of public site configurations.'); }
  const parsed = z.array(siteSchema).min(1).max(30).safeParse(rawSites);
  if (!parsed.success) throw new Error('KARI_SITES_JSON contains an invalid site ID, origin or field.');
  if (new Set(parsed.data.map(site => site.id)).size !== parsed.data.length) throw new Error('KARI_SITES_JSON site IDs must be unique.');
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  const baseUrl = env.AI_BASE_URL ?? 'https://ai.yogathedev.com/v1';
  if (baseUrl !== 'https://ai.yogathedev.com/v1') throw new Error('AI_BASE_URL must be the approved yogathedev endpoint.');
  const model = env.AI_DEFAULT_MODEL ?? 'deepseek-v4-flash';
  if (model !== 'deepseek-v4-flash') throw new Error('Only the economical deepseek-v4-flash model is enabled in this release.');
  const enabled = boolean(env.AI_ENABLED, false, 'AI_ENABLED');
  const verified = boolean(env.AI_CAPABILITIES_VERIFIED, false, 'AI_CAPABILITIES_VERIFIED');
  if (enabled && (!verified || !env.AI_API_KEY)) throw new Error('AI requires documented capability/privacy verification and a server-side AI_API_KEY.');
  const trustedProxies = (env.KARI_TRUSTED_PROXIES ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (trustedProxies.length > 20 || trustedProxies.some(value => {
    const [address, mask] = value.split('/');
    const version = isIP(address ?? '');
    return !version || (mask !== undefined && (!/^\d+$/u.test(mask) || Number(mask) > (version === 4 ? 32 : 128))) || value.split('/').length > 2;
  })) throw new Error('KARI_TRUSTED_PROXIES must contain only explicit proxy IPs/CIDRs.');
  return {
    host: env.HOST ?? '0.0.0.0', port,
    sites: parsed.data.map(site => ({ ...site, knowledgePath: site.knowledgePath ? resolve(site.knowledgePath) : undefined })),
    databaseUrl: env.DATABASE_URL,
    trustedProxies,
    ai: { enabled, verified, baseUrl, model, apiKey: env.AI_API_KEY },
  };
}

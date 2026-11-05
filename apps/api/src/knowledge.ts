import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { SiteConfig } from './config.js';

const chunkSchema = z.object({ id: z.string().min(1).max(100), href: z.string().regex(/^\/(?!\/)/u).max(300), text: z.string().min(1).max(2500) });
const knowledgeSchema = z.object({
  schemaVersion: z.literal(1), siteId: z.string(), sourceOrigin: z.string().url(),
  contentVersion: z.string().regex(/^[a-f0-9]{64}$/u), chunks: z.array(chunkSchema).max(200),
});
export interface Knowledge { sourceOrigin: string; version: string; chunks: z.infer<typeof chunkSchema>[]; }
export interface Source { title: string; url: string; }
export interface Answer { text: string; sources: Source[]; mode: 'local' | 'ai'; }

export async function loadKnowledge(site: SiteConfig): Promise<Knowledge> {
  const empty: Knowledge = { sourceOrigin: site.origins[0]!, version: 'empty', chunks: [] };
  if (!site.knowledgePath) return empty;
  try {
    if ((await stat(site.knowledgePath)).size > 256 * 1024) return empty;
    const parsed = knowledgeSchema.safeParse(JSON.parse(await readFile(site.knowledgePath, 'utf8')));
    if (!parsed.success || parsed.data.siteId !== site.id) return empty;
    const url = new URL(parsed.data.sourceOrigin);
    if (!site.origins.includes(url.origin) || parsed.data.sourceOrigin !== url.origin) return empty;
    return { sourceOrigin: url.origin, version: parsed.data.contentVersion, chunks: parsed.data.chunks };
  } catch { return empty; }
}

export function tokenize(text: string): string[] {
  return text.toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}+#.]+/gu) ?? [];
}

export function retrieve(message: string, knowledge: Knowledge) {
  const ignored = new Set(['apa', 'yang', 'dan', 'di', 'ke', 'the', 'is', 'a', 'an', 'of', 'tell', 'me', 'tentang', 'jelaskan', 'what', 'jovan', 'kari']);
  const words = [...new Set(tokenize(message).filter(word => word.length > 1 && !ignored.has(word)))];
  return knowledge.chunks.map(chunk => ({ chunk, score: words.reduce((total, word) => total + (tokenize(chunk.text).includes(word) ? 1 : 0) + (chunk.id.includes(word) ? 2 : 0), 0) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map(item => item.chunk);
}

export function sourceFor(chunk: Knowledge['chunks'][number], knowledge: Knowledge): Source {
  return { title: chunk.id.replaceAll('-', ' '), url: new URL(chunk.href, knowledge.sourceOrigin).href };
}

export function localAnswer(message: string, site: SiteConfig, knowledge: Knowledge): Answer | undefined {
  const normalized = message.trim().toLocaleLowerCase();
  const english = /\b(hello|hi|what|which|tell|your|contact|project|skills|how|compare)\b/u.test(normalized);
  const reply = (text: string, chunks: Knowledge['chunks'] = []): Answer => ({ text, sources: chunks.map(chunk => sourceFor(chunk, knowledge)), mode: 'local' });
  if (/^(hai|halo|hello|hi|hey|hei|pagi|siang|malam|kari)[\s!,.?]*$/u.test(normalized)) {
    return reply(english ? `Hi! I'm KARI, the AI sidekick for ${site.name}. What would you like to know?` : `Hai! Aku KARI, sidekick AI untuk ${site.name}. Mau kenalan dengan karya-karyanya? 😉`);
  }
  if (/\b(api[ _-]?key|password|token rahasia|system prompt|prompt sistem|specialperson|private notes|catatan pribadi|aku jovan|i am jovan)\b/u.test(normalized)) {
    return reply(english ? 'This is public chat. Private information and owner actions require separate server authentication.' : 'Ini chat publik. Data pribadi dan aksi pemilik memerlukan autentikasi server tersendiri.');
  }
  if (/\b(contact|kontak|email|github|cv|hubungi)\b/u.test(normalized)) {
    const contact = knowledge.chunks.find(chunk => chunk.id === 'contact');
    return contact ? reply(contact.text, [contact]) : reply(english ? 'No verified public contact is configured for this site.' : 'Belum ada kontak publik terverifikasi untuk website ini.');
  }
  const selected = retrieve(message, knowledge);
  const direct = selected.filter(chunk => {
    const name = chunk.text.split(':', 1)[0]?.toLocaleLowerCase();
    return (name && normalized.includes(name)) || (/\b(genbatik|batikpedia|raho)\b/u.test(normalized) && chunk.id.startsWith('project-'));
  });
  if (direct.length && !/\b(compare|banding|arsitektur|architecture|trade.?off|versus|vs|mengapa|why|detail)\b/u.test(normalized)) {
    return reply(direct.slice(0, 2).map(chunk => chunk.text).join('\n\n'), direct.slice(0, 2));
  }
  if (!selected.length) return reply(english ? 'I do not have verified information about that here. Ask about the published projects, skills or contact details.' : 'Aku belum punya informasi terverifikasi tentang itu. Kamu bisa tanya proyek, skill atau kontak yang dipublikasikan di website ini.');
  return undefined;
}

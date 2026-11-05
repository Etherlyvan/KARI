import { timingSafeEqual } from 'node:crypto';
import { PersistenceError, type OwnerStore } from './persistence.js';

export class OwnerError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'OwnerError'; }
}
export type OwnerOptions = {
  ownerId: string;
  webhookSecret: string;
  receivedSecret: string | undefined;
  store: OwnerStore;
  now?: Date;
  chat?: (input: { ownerId: string; requestId: string; message: string }) => Promise<string>;
};
export type OwnerReply = { text: string; chatId: string };

export function verifyWebhookSecret(expected: string, received: string | undefined): boolean {
  if (!/^[a-zA-Z0-9_-]{16,256}$/u.test(expected) || !received) return false;
  const a = Buffer.from(expected), b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function numericId(value: unknown): string | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}
function excerpt(text: string, length = 100) { const letters = Array.from(text); return letters.length > length ? `${letters.slice(0, length).join('')}…` : text; }
export function formatWib(date: Date): string {
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' }).format(date) + ' WIB';
}

/** Explicit offset only; no guessing "tomorrow" or interpreting host timezone. */
export function parseReminderDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  if (year! < 2000 || year! > 2100 || month! < 1 || month! > 12 || day! < 1 || hour! > 23 || minute! > 59 || second! > 59) return null;
  const calendar = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month! - 1 || calendar.getUTCDate() !== day) return null;
  const offset = m[7]!;
  if (offset !== 'Z') {
    const h = Number(offset.slice(1, 3)), min = Number(offset.slice(4, 6));
    if (h > 14 || min > 59 || (h === 14 && min !== 0)) return null;
  }
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}

/** Only verified direct Telegram messages can reach durable owner operations. */
export async function handleTelegramUpdate(update: unknown, options: OwnerOptions): Promise<OwnerReply | null> {
  if (!verifyWebhookSecret(options.webhookSecret, options.receivedSecret)) throw new OwnerError('WEBHOOK_UNAUTHORIZED');
  if (!/^[1-9]\d{0,19}$/u.test(options.ownerId)) throw new OwnerError('OWNER_NOT_CONFIGURED');
  const envelope = object(update), message = object(envelope?.message);
  const from = object(message?.from), chat = object(message?.chat);
  const sender = numericId(from?.id), chatId = numericId(chat?.id), messageId = numericId(message?.message_id);
  if (sender !== options.ownerId || chatId !== options.ownerId || chat?.type !== 'private' || from?.is_bot === true || !messageId) return null;
  const now = options.now ?? new Date();
  // A captured webhook cannot be replayed indefinitely after cancelling/expiring records.
  const sentAt = typeof message?.date === 'number' ? message.date * 1000 : NaN;
  if (!Number.isFinite(sentAt) || sentAt > now.getTime() + 60000 || sentAt < now.getTime() - 24 * 3600000) return null;
  const raw = message?.text;
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 8192) return { chatId, text: 'Pesannya terlalu panjang, Jovan. Coba ringkas dulu, ya.' };
  const text = raw.trim();
  const requestId = `telegram:${options.ownerId}:${messageId}`;
  const reply = (body: string): OwnerReply => ({ chatId, text: body });
  try {
    if (text.startsWith('/note ')) {
      const note = await options.store.createNote({ ownerId: options.ownerId, requestId, text: text.slice(6).trim() });
      return reply(`Sudah kusimpan, Jovan 😉\n${excerpt(note.text, 180)}\nID: ${note.id}`);
    }
    if (text === '/notes') {
      const notes = await options.store.listNotes(options.ownerId);
      return reply(notes.length ? `Catatan terbarumu, Jovan:\n${notes.map(note => `• ${excerpt(note.text)}\n  ${note.id}`).join('\n')}` : 'Belum ada catatan tersimpan, Jovan. Pakai /note diikuti isi catatan.');
    }
    if (text.startsWith('/remind ')) {
      const match = /^\/remind\s+(\S+)\s+([\s\S]+)$/u.exec(text);
      const dueAt = match ? parseReminderDate(match[1]!) : null;
      if (!match || !dueAt) return reply('Tulis waktu lengkap dengan zona, ya: /remind 2026-12-01T09:00+07:00 review CV\nBelum ada reminder dibuat.');
      const reminder = await options.store.createReminder({
        ownerId: options.ownerId, requestId, text: match[2]!.trim(), channel: 'telegram',
        recipient: options.ownerId, dueAt, now,
      });
      return reply(`Reminder Telegram tersimpan untuk ${formatWib(reminder.dueAt)}, Jovan 😉\n${excerpt(reminder.text, 160)}\nID: ${reminder.id}\nKirim /cancel ${reminder.id} untuk membatalkan sebelum mulai dikirim.`);
    }
    if (text === '/reminders') {
      const reminders = await options.store.listReminders(options.ownerId);
      return reply(reminders.length ? `Remindermu, Jovan:\n${reminders.map(reminder => `• ${formatWib(reminder.dueAt)} [${reminder.status}] ${excerpt(reminder.text, 70)}\n  ${reminder.id}`).join('\n')}` : 'Tidak ada reminder aktif atau belum terselesaikan, Jovan.');
    }
    if (text.startsWith('/cancel ')) {
      const id = text.slice(8).trim();
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(id)) return reply('Salin ID reminder dari /reminders, ya. Belum ada perubahan.');
      const cancelled = await options.store.cancelReminder(options.ownerId, id);
      return reply(cancelled ? 'Reminder dibatalkan, Jovan.' : 'Reminder tidak ditemukan atau sudah mulai diproses. Aku belum bisa menjamin pembatalannya; cek /reminders.');
    }
    if (options.chat && text && !text.startsWith('/')) return reply(await options.chat({ ownerId: options.ownerId, requestId, message: text }));
    return reply('Aku di sini, Jovan 😉 Perintah pribadi:\n/note isi catatan\n/notes\n/remind tanggalISO pesan\n/reminders\n/cancel ID\nWhatsApp dan jadwal berulang belum diaktifkan.');
  } catch (error) {
    if (error instanceof PersistenceError && ['INVALID_DUE', 'INVALID_TEXT', 'NOTE_LIMIT', 'REMINDER_LIMIT'].includes(error.code)) {
      const reason = error.code === 'INVALID_DUE' ? 'Waktu harus di masa depan dan maksimal 366 hari lagi.' : error.code === 'INVALID_TEXT' ? 'Isi harus terisi dan maksimal 4 KiB.' : 'Batas penyimpanan aktif sudah tercapai.';
      return reply(`${reason} Belum ada data baru yang kusimpan, Jovan.`);
    }
    return reply('Penyimpanan belum bisa dipastikan berhasil, Jovan. Cek daftar catatan/reminder sebelum mencoba lagi; aku tidak akan mengaku sudah menyimpan jika belum terkonfirmasi.');
  }
}

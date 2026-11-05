import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

export type SpendingLimits = {
  dailyMicroUsd: bigint;
  monthlyMicroUsd: bigint;
  models: Record<string, { dailyMicroUsd: bigint; monthlyMicroUsd: bigint }>;
};

export const DEFAULT_SPENDING_LIMITS: SpendingLimits = {
  dailyMicroUsd: 1_000_000n,
  monthlyMicroUsd: 20_000_000n,
  models: {
    'deepseek-v4-flash': { dailyMicroUsd: 600_000n, monthlyMicroUsd: 12_000_000n },
    'gpt-6-luna': { dailyMicroUsd: 100_000n, monthlyMicroUsd: 2_000_000n },
    'minimax-m3.1-flash': { dailyMicroUsd: 100_000n, monthlyMicroUsd: 2_000_000n },
    'glm-5.3': { dailyMicroUsd: 200_000n, monthlyMicroUsd: 4_000_000n },
  },
};

export class PersistenceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'PersistenceError'; }
}

export interface SpendingStore {
  reserve(input: { id: string; model: string; maxMicroUsd: bigint; now: Date }): Promise<string>;
  /** No actual usage = retain the full worst-case reservation indefinitely. */
  settle(reservationId: string, actualMicroUsd?: bigint): Promise<void>;
  /** Stop all future inference after a provider contract violation, across paths and restarts. */
  block?(reason: string): Promise<void>;
}

/** Calendar boundaries are WIB, independent of host/container timezone. */
export function budgetPeriods(now: Date): { day: string; month: string } {
  if (!Number.isFinite(now.getTime())) throw new PersistenceError('INVALID_DATE', 'Invalid accounting date.');
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString();
  return { day: wib.slice(0, 10), month: wib.slice(0, 7) };
}

export function reservationBuckets(model: string, amount: bigint, now: Date, limits: SpendingLimits) {
  if (amount <= 0n) throw new PersistenceError('INVALID_COST', 'Reservation must be positive.');
  const perModel = Object.hasOwn(limits.models, model) ? limits.models[model] : undefined;
  if (!perModel) throw new PersistenceError('MODEL_DENIED', 'No spending allowance for this model.');
  const { day, month } = budgetPeriods(now);
  return [
    { id: `global:day:${day}`, limit: limits.dailyMicroUsd },
    { id: `global:month:${month}`, limit: limits.monthlyMicroUsd },
    { id: `model:${model}:day:${day}`, limit: perModel.dailyMicroUsd },
    { id: `model:${model}:month:${month}`, limit: perModel.monthlyMicroUsd },
  ];
}

export function assertWithinLimit(used: bigint, amount: bigint, limit: bigint): void {
  if (used < 0n || amount <= 0n || limit < 0n || used + amount > limit) {
    throw new PersistenceError('BUDGET_EXHAUSTED', 'Spending allowance exhausted.');
  }
}

export function settlementDelta(maximum: bigint, currentActual: bigint | null, actual: bigint | undefined): bigint {
  if (actual === undefined) return 0n;
  if (actual < 0n) throw new PersistenceError('INVALID_COST', 'Usage cannot be negative.');
  if (currentActual !== null && currentActual !== actual) throw new PersistenceError('SETTLEMENT_CONFLICT', 'Reservation already settled differently.');
  return currentActual === null ? actual - maximum : 0n;
}

export type NoteRecord = { id: string; ownerId: string; text: string; createdAt: Date };
export type ReminderRecord = {
  id: string; ownerId: string; text: string; channel: string; recipient: string;
  dueAt: Date; expiresAt: Date; status: string; attempts: number;
  nextAttemptAt: Date; leaseId: string | null; leaseUntil: Date | null;
};
export type NewReminder = {
  ownerId: string; requestId: string; text: string; channel: 'telegram' | 'whatsapp';
  recipient: string; dueAt: Date; now: Date;
};
export interface OwnerStore {
  createNote(input: { ownerId: string; requestId: string; text: string }): Promise<NoteRecord>;
  listNotes(ownerId: string): Promise<NoteRecord[]>;
  createReminder(input: NewReminder): Promise<ReminderRecord>;
  listReminders(ownerId: string): Promise<ReminderRecord[]>;
  cancelReminder(ownerId: string, id: string): Promise<boolean>;
}
export type ReminderUpdate = {
  status: 'accepted' | 'delivered' | 'failed' | 'unknown' | 'pending';
  nextAttemptAt?: Date; providerId?: string; errorCode?: string;
};
export interface ReminderStore {
  claimDue(now: Date, limit?: number): Promise<ReminderRecord[]>;
  isClaimActive(id: string, leaseId: string, now: Date): Promise<boolean>;
  finishReminder(id: string, leaseId: string, update: ReminderUpdate): Promise<void>;
}

function validateOwner(ownerId: string) {
  if (!/^[1-9]\d{0,19}$/u.test(ownerId)) throw new PersistenceError('INVALID_OWNER', 'Invalid owner identity.');
}
function validateText(text: string) {
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > 4096) throw new PersistenceError('INVALID_TEXT', 'Text must be 1–4096 UTF-8 bytes.');
}
function validateRequestId(id: string) {
  if (!/^[a-zA-Z0-9:_-]{1,160}$/u.test(id)) throw new PersistenceError('INVALID_ID', 'Invalid request identity.');
}

export class PrismaPersistence implements SpendingStore, OwnerStore, ReminderStore {
  readonly client: PrismaClient;
  constructor(databaseUrl: string, private readonly limits: SpendingLimits = DEFAULT_SPENDING_LIMITS) {
    this.client = new PrismaClient({ adapter: new PrismaPg({
      connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000, statement_timeout: 10000,
    }) });
  }
  async close() { await this.client.$disconnect(); }

  async block(reason: string): Promise<void> {
    if (!/^[A-Z0-9_]{1,80}$/u.test(reason)) throw new PersistenceError('INVALID_BLOCK_REASON', 'Use a bounded diagnostic code without private data.');
    await this.client.$transaction(async tx => {
      // Share the admission lock so another path cannot reserve between checking and blocking.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1262572105, 1)`;
      await tx.financialState.upsert({ where: { id: 'inference' },
        create: { id: 'inference', blockedReason: reason }, update: { blockedReason: reason },
      });
    }, { maxWait: 5000, timeout: 10000 });
  }

  async reserve(input: { id: string; model: string; maxMicroUsd: bigint; now: Date }): Promise<string> {
    validateRequestId(input.id);
    const buckets = reservationBuckets(input.model, input.maxMicroUsd, input.now, this.limits);
    return this.client.$transaction(async tx => {
      // A single database-wide admission lock covers all four counters across processes.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1262572105, 1)`;
      const blocked = await tx.financialState.findUnique({ where: { id: 'inference' } });
      if (blocked?.blockedReason) throw new PersistenceError('ACCOUNTING_BLOCKED', 'Inference accounting requires operator review.');
      if (await tx.spendReservation.findUnique({ where: { id: input.id } })) {
        throw new PersistenceError('RESERVATION_EXISTS', 'Request already admitted; do not replay inference.');
      }
      for (const bucket of buckets) {
        const current = await tx.spendBucket.findUnique({ where: { id: bucket.id } });
        assertWithinLimit(current?.usedMicroUsd ?? 0n, input.maxMicroUsd, bucket.limit);
      }
      await tx.spendReservation.create({ data: {
        id: input.id, model: input.model, maxMicroUsd: input.maxMicroUsd,
        bucketIds: buckets.map(bucket => bucket.id), createdAt: input.now,
      } });
      for (const bucket of buckets) await tx.spendBucket.upsert({
        where: { id: bucket.id }, create: { id: bucket.id, usedMicroUsd: input.maxMicroUsd },
        update: { usedMicroUsd: { increment: input.maxMicroUsd } },
      });
      return input.id;
    }, { maxWait: 5000, timeout: 10000 });
  }

  async settle(reservationId: string, actualMicroUsd?: bigint): Promise<void> {
    if (actualMicroUsd === undefined) return; // Unknown means fully held, including after restart.
    const overspent = await this.client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1262572105, 1)`;
      const reservation = await tx.spendReservation.findUnique({ where: { id: reservationId } });
      if (!reservation) throw new PersistenceError('RESERVATION_MISSING', 'Unknown spending reservation.');
      const delta = settlementDelta(reservation.maxMicroUsd, reservation.actualMicroUsd, actualMicroUsd);
      if (reservation.status === 'settled') return false;
      for (const id of reservation.bucketIds) await tx.spendBucket.update({
        where: { id }, data: { usedMicroUsd: { increment: delta } },
      });
      await tx.spendReservation.update({ where: { id: reservationId }, data: {
        actualMicroUsd, status: 'settled', settledAt: new Date(),
      } });
      if (actualMicroUsd > reservation.maxMicroUsd) {
        await tx.financialState.upsert({ where: { id: 'inference' },
          create: { id: 'inference', blockedReason: 'Billed usage exceeded reserved maximum.' },
          update: { blockedReason: 'Billed usage exceeded reserved maximum.' },
        });
        return true;
      }
      return false;
    }, { maxWait: 5000, timeout: 10000 });
    if (overspent) throw new PersistenceError('ACCOUNTING_BLOCKED', 'Actual usage exceeded reservation; further inference blocked.');
  }

  async createNote(input: { ownerId: string; requestId: string; text: string }): Promise<NoteRecord> {
    validateOwner(input.ownerId); validateRequestId(input.requestId); validateText(input.text);
    return this.client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1262572105, 2)`;
      const existing = await tx.note.findUnique({ where: { requestId: input.requestId } });
      if (existing) {
        if (existing.ownerId !== input.ownerId || existing.text !== input.text) throw new PersistenceError('REQUEST_CONFLICT', 'Request identity already used.');
        return existing;
      }
      if (await tx.note.count({ where: { ownerId: input.ownerId } }) >= 1000) throw new PersistenceError('NOTE_LIMIT', 'Note limit reached.');
      return tx.note.create({ data: input });
    });
  }
  async listNotes(ownerId: string): Promise<NoteRecord[]> {
    validateOwner(ownerId);
    return this.client.note.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, take: 20 });
  }
  async createReminder(input: NewReminder): Promise<ReminderRecord> {
    validateOwner(input.ownerId); validateRequestId(input.requestId); validateText(input.text);
    const due = input.dueAt.getTime(), now = input.now.getTime();
    if (!Number.isFinite(due) || !Number.isFinite(now) || due <= now || due - now > 366 * 86400000) {
      throw new PersistenceError('INVALID_DUE', 'Reminder must be in the next 366 days.');
    }
    // Other channels need their own consent/template/cost gate before durable enqueue is enabled.
    if (input.channel !== 'telegram') throw new PersistenceError('CHANNEL_DISABLED', 'WhatsApp scheduling is not enabled.');
    if (input.recipient !== input.ownerId) throw new PersistenceError('INVALID_RECIPIENT', 'Only the verified Telegram owner may receive reminders.');
    return this.client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1262572105, 2)`;
      const existing = await tx.reminder.findUnique({ where: { requestId: input.requestId } });
      if (existing) {
        if (existing.ownerId !== input.ownerId || existing.text !== input.text || existing.dueAt.getTime() !== due || existing.recipient !== input.recipient || existing.channel !== input.channel) {
          throw new PersistenceError('REQUEST_CONFLICT', 'Request identity already used.');
        }
        return existing;
      }
      const active = await tx.reminder.count({ where: { ownerId: input.ownerId, status: { in: ['pending', 'claimed'] } } });
      if (active >= 100) throw new PersistenceError('REMINDER_LIMIT', 'Active reminder limit reached.');
      return tx.reminder.create({ data: {
        ownerId: input.ownerId, requestId: input.requestId, text: input.text,
        channel: input.channel, recipient: input.recipient, dueAt: input.dueAt,
        nextAttemptAt: input.dueAt, expiresAt: new Date(due + 15 * 60000),
      } });
    });
  }
  async listReminders(ownerId: string): Promise<ReminderRecord[]> {
    validateOwner(ownerId);
    return this.client.reminder.findMany({
      where: { ownerId, status: { in: ['pending', 'claimed', 'accepted', 'unknown', 'missed'] } },
      orderBy: { dueAt: 'asc' }, take: 20,
    });
  }
  async cancelReminder(ownerId: string, id: string): Promise<boolean> {
    validateOwner(ownerId);
    const result = await this.client.reminder.updateMany({
      // Once claimed, a network delivery may already be underway: never claim cancellation succeeded.
      where: { id, ownerId, status: 'pending' },
      data: { status: 'cancelled', leaseId: null, leaseUntil: null },
    });
    return result.count === 1;
  }

  async claimDue(now: Date, limit = 20): Promise<ReminderRecord[]> {
    const batch = Math.max(1, Math.min(20, Math.trunc(limit)));
    return this.client.$transaction(async tx => {
      // An expired sending lease is ambiguous, not permission to send again.
      await tx.reminder.updateMany({ where: { status: 'claimed', leaseUntil: { lte: now } },
        data: { status: 'unknown', leaseId: null, leaseUntil: null, lastError: 'LEASE_EXPIRED' } });
      await tx.reminder.updateMany({ where: { status: 'pending', expiresAt: { lte: now } }, data: { status: 'missed' } });
      const rows = await tx.$queryRaw<ReminderRecord[]>(Prisma.sql`
        SELECT * FROM "Reminder" WHERE "status" = 'pending'
          AND "nextAttemptAt" <= ${now} AND "expiresAt" > ${now}
        ORDER BY "nextAttemptAt" ASC LIMIT ${batch} FOR UPDATE SKIP LOCKED
      `);
      const claimed: ReminderRecord[] = [];
      for (const row of rows) {
        const leaseId = randomUUID();
        claimed.push(await tx.reminder.update({ where: { id: row.id }, data: {
          status: 'claimed', leaseId, leaseUntil: new Date(now.getTime() + 60000), attempts: { increment: 1 },
        } }));
      }
      return claimed;
    });
  }
  async isClaimActive(id: string, leaseId: string, now: Date): Promise<boolean> {
    return !!await this.client.reminder.findFirst({ where: {
      id, leaseId, status: 'claimed', leaseUntil: { gt: now }, expiresAt: { gt: now },
    }, select: { id: true } });
  }
  async finishReminder(id: string, leaseId: string, update: ReminderUpdate): Promise<void> {
    await this.client.reminder.updateMany({ where: { id, leaseId, status: 'claimed' }, data: {
      status: update.status, leaseId: null, leaseUntil: null,
      ...(update.nextAttemptAt ? { nextAttemptAt: update.nextAttemptAt } : {}),
      ...(update.providerId ? { providerId: update.providerId.slice(0, 200) } : {}),
      lastError: update.errorCode?.slice(0, 80) ?? null,
    } });
  }
}

export function createPersistence(databaseUrl: string, limits = DEFAULT_SPENDING_LIMITS): PrismaPersistence {
  return new PrismaPersistence(databaseUrl, limits);
}

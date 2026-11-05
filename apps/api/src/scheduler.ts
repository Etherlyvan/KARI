import type { ReminderRecord, ReminderStore, ReminderUpdate } from './persistence.js';

export type DeliveryResult =
  | { status: 'accepted'; providerId?: string }
  | { status: 'delivered'; providerId?: string }
  | { status: 'retryable'; errorCode: string } // Adapter guarantees provider did NOT accept it.
  | { status: 'failed'; errorCode: string }
  | { status: 'unknown'; errorCode: string };
export interface ReminderSender {
  /** Must enforce enabled channel/verified recipient/consent and its own monetary cap before sending. */
  send(reminder: ReminderRecord, signal: AbortSignal): Promise<DeliveryResult>;
}
export type SchedulerOptions = {
  store: ReminderStore;
  sender: ReminderSender;
  clock?: () => Date;
  intervalMs?: number;
  deliveryTimeoutMs?: number;
  onError?: (code: string) => void;
};

export function deliveryUpdate(reminder: ReminderRecord, result: DeliveryResult, now: Date): ReminderUpdate {
  if (result.status === 'accepted' || result.status === 'delivered') {
    return { status: result.status, ...(result.providerId ? { providerId: result.providerId } : {}) };
  }
  if (result.status === 'retryable') {
    const delay = [60000, 300000, 900000][reminder.attempts - 1];
    const next = delay === undefined ? null : new Date(now.getTime() + delay);
    return next && next < reminder.expiresAt
      ? { status: 'pending', nextAttemptAt: next, errorCode: result.errorCode }
      : { status: 'failed', errorCode: 'RETRY_LIMIT_OR_EXPIRED' };
  }
  return { status: result.status, errorCode: result.errorCode };
}

/** One bounded loop; no queue/worker process and no LLM invocation. */
export class ReminderScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private running = false;
  private stopping = false;
  private readonly clock: () => Date;
  constructor(private readonly options: SchedulerOptions) { this.clock = options.clock ?? (() => new Date()); }

  start(): void {
    if (this.running) return;
    this.running = true; this.stopping = false;
    this.schedule(0);
  }
  private schedule(delay: number) {
    this.timer = setTimeout(() => {
      void this.tick().finally(() => { if (this.running) this.schedule(this.options.intervalMs ?? 30000); });
    }, delay);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.running = false; this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort();
    await this.active;
  }
  async tick(): Promise<void> {
    if (this.active) return this.active;
    if (this.stopping) return;
    this.active = this.processBatch();
    try { await this.active; } finally { this.active = null; }
  }
  private async processBatch(): Promise<void> {
    try {
      for (let i = 0; i < 20 && !this.stopping; i++) {
        // Claim just before delivery so a slow earlier send cannot expire 19 unused leases.
        const [reminder] = await this.options.store.claimDue(this.clock(), 1);
        if (!reminder) return;
        const leaseId = reminder.leaseId;
        if (this.stopping) {
          // Nothing has been sent yet, so returning this claim to pending is safe.
          if (leaseId) await this.options.store.finishReminder(reminder.id, leaseId, { status: 'pending', nextAttemptAt: this.clock() });
          return;
        }
        if (!leaseId || !await this.options.store.isClaimActive(reminder.id, leaseId, this.clock())) continue;
        const controller = new AbortController(); this.abort = controller;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        let result: DeliveryResult;
        try {
          const interrupted = new Promise<DeliveryResult>(resolve => {
            onAbort = () => resolve({ status: 'unknown', errorCode: 'DELIVERY_INTERRUPTED' });
            controller.signal.addEventListener('abort', onAbort, { once: true });
            timeout = setTimeout(() => controller.abort(), this.options.deliveryTimeoutMs ?? 20000);
          });
          result = await Promise.race([this.options.sender.send(reminder, controller.signal), interrupted]);
        } catch {
          // A thrown transport error cannot prove the provider did not accept the message.
          result = { status: 'unknown', errorCode: 'DELIVERY_OUTCOME_UNKNOWN' };
        } finally {
          if (timeout) clearTimeout(timeout);
          if (onAbort) controller.signal.removeEventListener('abort', onAbort);
          this.abort = null;
        }
        await this.options.store.finishReminder(reminder.id, leaseId, deliveryUpdate(reminder, result, this.clock()));
      }
    } catch {
      // A failed completion write leaves the durable lease; recovery marks unknown, never blindly retries.
      this.options.onError?.('SCHEDULER_STORAGE_UNAVAILABLE');
    }
  }
}

/** Safe default while no real, policy-checked channel adapter has been configured. */
export const disabledReminderSender: ReminderSender = {
  async send() { return { status: 'failed', errorCode: 'CHANNEL_DISABLED' }; },
};

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWithinLimit, budgetPeriods, DEFAULT_SPENDING_LIMITS, reservationBuckets, settlementDelta,
} from '../apps/api/src/persistence.js';

test('financial calendar rolls over at Jakarta midnight, including month/year', () => {
  assert.deepEqual(budgetPeriods(new Date('2026-12-31T16:59:59Z')), { day: '2026-12-31', month: '2026-12' });
  assert.deepEqual(budgetPeriods(new Date('2026-12-31T17:00:00Z')), { day: '2027-01-01', month: '2027-01' });
});

test('all four independent ceilings include the same worst-case reservation', () => {
  const rows = reservationBuckets('deepseek-v4-flash', 234n, new Date('2026-11-05T10:00:00Z'), DEFAULT_SPENDING_LIMITS);
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(row => row.id)).size, 4);
  for (const row of rows) {
    assert.doesNotThrow(() => assertWithinLimit(row.limit - 234n, 234n, row.limit));
    assert.throws(() => assertWithinLimit(row.limit - 233n, 234n, row.limit), { code: 'BUDGET_EXHAUSTED' });
  }
  assert.throws(() => reservationBuckets('auto', 1n, new Date(), DEFAULT_SPENDING_LIMITS), { code: 'MODEL_DENIED' });
  assert.throws(() => reservationBuckets('toString', 1n, new Date(), DEFAULT_SPENDING_LIMITS), { code: 'MODEL_DENIED' });
  assert.throws(() => assertWithinLimit(0n, 1n, 0n), { code: 'BUDGET_EXHAUSTED' });
});

test('unknown usage holds budget; known settlement refunds once; conflicting replay fails', () => {
  assert.equal(settlementDelta(300n, null, undefined), 0n);
  assert.equal(settlementDelta(300n, null, 210n), -90n);
  assert.equal(settlementDelta(300n, 210n, 210n), 0n);
  assert.throws(() => settlementDelta(300n, 210n, 209n), { code: 'SETTLEMENT_CONFLICT' });
  assert.throws(() => settlementDelta(300n, null, -1n), { code: 'INVALID_COST' });
  assert.equal(settlementDelta(300n, null, 350n), 50n); // Account actual overage before closing admission.
});

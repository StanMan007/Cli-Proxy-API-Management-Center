import { describe, expect, test } from 'bun:test';
import {
  appendSnapshot,
  historyRate,
  project,
  weekRate,
  WEEK_MS,
  type PoolSnapshot,
} from '@/features/quota/forecast';
import type { OverviewAccount } from '@/features/quota/overview';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 14, 12);

const account = (
  weeklyLeft: number,
  refillIn: number,
  extra: Partial<OverviewAccount> = {}
): OverviewAccount =>
  ({
    key: `a${weeklyLeft}-${refillIn}`,
    provider: 'claude',
    status: 'success',
    plan: null,
    weight: 1,
    weeklyLeft,
    session: null,
    tighter: null,
    refillAtMs: NOW + refillIn,
    resets: [],
    ...extra,
  }) as OverviewAccount;

describe('quota forecast', () => {
  test('week rate sums each account’s burn since its week began', () => {
    // 50% used over 3.5 days = ~0.595%/h; a Pro 200 at 70% used over 1 day = 2 * 70 / 24.
    const rate = weekRate([account(50, 3.5 * DAY), account(30, 6 * DAY, { weight: 2 })], NOW);
    expect(rate?.source).toBe('week');
    expect(rate?.perHour).toBeCloseTo(50 / 84 + 140 / 24, 5);
  });

  test('history rate counts drops only and skips refills and account changes', () => {
    const history: PoolSnapshot[] = [
      { t: NOW - 6 * HOUR, remaining: 300, capacity: 600 },
      { t: NOW - 4 * HOUR, remaining: 290, capacity: 600 },
      { t: NOW - 3 * HOUR, remaining: 390, capacity: 600 }, // refill
      { t: NOW - 2 * HOUR, remaining: 280, capacity: 500 }, // account removed
      { t: NOW, remaining: 270, capacity: 500 },
    ];
    // 20 drained over 5h of comparable spans; the rise adds time but no drain, the removal is skipped.
    expect(historyRate(history, NOW)).toEqual({ perHour: 20 / 5, source: 'history' });
    expect(historyRate(history.slice(-2), NOW)).toBeNull();
  });

  test('projection drains evenly, refills on schedule and finds when the pool runs dry', () => {
    const accounts = [account(10, 2 * DAY), account(40, 10 * DAY)];
    const { points, refills, dryAtMs } = project(accounts, 5, NOW, 3 * DAY);
    expect(points[0].remaining).toBe(50);
    // 2.5%/h each: the first empties in 4h, the second carries 5%/h until it empties at hour 10.
    expect(dryAtMs).toBe(NOW + 10 * HOUR);
    expect(refills).toEqual([{ t: NOW + 2 * DAY, gain: 100 }]);
    expect(points.find((p) => p.t === NOW + 2 * DAY)?.remaining).toBeCloseTo(100 - 1.25, 5);
  });

  test('banked resets extend the projection when an account runs dry', () => {
    const accounts = [account(5, 5 * DAY, { resets: [NOW + 3 * DAY, null] })];
    const base = project(accounts, 2, NOW, 2 * DAY);
    const withResets = project(accounts, 2, NOW, 2 * DAY, true);
    expect(base.dryAtMs).toBe(NOW + 2.5 * HOUR);
    expect(withResets.resetsUsed).toBe(1);
    expect(withResets.dryAtMs).toBeNull();
    expect(WEEK_MS).toBe(7 * DAY);
  });

  test('history skips repeated readings and drops old ones', () => {
    const old = { t: NOW - 20 * DAY, remaining: 100, capacity: 600 };
    const last = { t: NOW - 5 * 60 * 1000, remaining: 250, capacity: 600 };
    expect(appendSnapshot([old, last], { t: NOW, remaining: 250, capacity: 600 })).toEqual([last]);
    expect(appendSnapshot([last], { t: NOW, remaining: 240, capacity: 600 })).toHaveLength(2);
  });
});

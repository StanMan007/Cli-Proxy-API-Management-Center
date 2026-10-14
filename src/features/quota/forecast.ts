/**
 * Pooled quota forecast: how fast a provider's summed weekly quota is draining and
 * how that plays out as accounts refill. Units match OverviewPool: one account's
 * full week is 100%, so six Claude accounts pool to 600%.
 *
 * The projection assumes the proxy load-balances: demand is split evenly across
 * every account that still has quota, and an account's leftovers are lost when its
 * week refills. React-free; consumed by QuotaForecast and tests/quotaForecast.test.ts.
 */

import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import type { OverviewAccount } from './overview';

export const WEEK_MS = 7 * DAY_MS;
const STEP_MS = 15 * MINUTE_MS;
/** History shorter than this is too noisy to trust; fall back to the weekly average. */
const MIN_HISTORY_MS = 3 * HOUR_MS;
/** The drain rate reads this much recent history. */
const RATE_WINDOW_MS = DAY_MS;
/** Early in a week one busy hour would read as a huge average; treat the week as at least this old. */
const MIN_ELAPSED_MS = 12 * HOUR_MS;
/** History older than this is dropped. */
export const HISTORY_KEEP_MS = 14 * DAY_MS;

/** One recorded reading of a pool's totals. */
export interface PoolSnapshot {
  t: number;
  remaining: number;
  capacity: number;
}

export interface ForecastPoint {
  t: number;
  remaining: number;
}

export interface DrainRate {
  perHour: number;
  /** `history`: measured over recorded readings. `week`: average burn since each week began. */
  source: 'history' | 'week';
}

export interface Projection {
  points: ForecastPoint[];
  /** Moments accounts refill during the projection, with how much each adds back. */
  refills: { t: number; gain: number }[];
  /** First moment every account is empty, or null if the pool lasts the whole horizon. */
  dryAtMs: number | null;
  resetsUsed: number;
}

/** Drain rate from recorded readings; refills (rises) and account changes are skipped. */
export function historyRate(history: readonly PoolSnapshot[], now: number): DrainRate | null {
  const recent = history.filter((point) => point.t >= now - RATE_WINDOW_MS && point.t <= now);
  if (recent.length < 2 || recent[recent.length - 1].t - recent[0].t < MIN_HISTORY_MS) return null;
  let drained = 0;
  let spanMs = 0;
  for (let i = 1; i < recent.length; i++) {
    const [prev, next] = [recent[i - 1], recent[i]];
    if (prev.capacity !== next.capacity) continue;
    drained += Math.max(0, prev.remaining - next.remaining);
    spanMs += next.t - prev.t;
  }
  return spanMs < MIN_HISTORY_MS
    ? null
    : { perHour: drained / (spanMs / HOUR_MS), source: 'history' };
}

/** Average burn since each account's week began, summed across accounts. */
export function weekRate(accounts: readonly OverviewAccount[], now: number): DrainRate | null {
  let perHour = 0;
  let counted = 0;
  for (const account of accounts) {
    if (account.weeklyLeft === null || account.refillAtMs === null || account.refillAtMs <= now)
      continue;
    const elapsed = Math.max(MIN_ELAPSED_MS, now - (account.refillAtMs - WEEK_MS));
    perHour += ((100 - account.weeklyLeft) * account.weight) / (elapsed / HOUR_MS);
    counted += 1;
  }
  return counted === 0 ? null : { perHour, source: 'week' };
}

export const drainRate = (
  accounts: readonly OverviewAccount[],
  history: readonly PoolSnapshot[],
  now: number
) => historyRate(history, now) ?? weekRate(accounts, now);

type SimAccount = { left: number; cap: number; refillAt: number | null; resets: number[] };

/** Take `amount` evenly from every account with quota left, spilling shortfalls onto the rest. */
function drain(accounts: SimAccount[], amount: number) {
  let need = amount;
  while (need > 1e-9) {
    const live = accounts.filter((account) => account.left > 0);
    if (live.length === 0) return;
    const share = need / live.length;
    need = 0;
    for (const account of live) {
      const take = Math.min(account.left, share);
      account.left -= take;
      need += share - take;
    }
  }
}

/**
 * Step the pool forward from `now` at `perHour`. With `useResets`, an account that
 * runs dry spends its soonest-expiring banked reset and starts a fresh week.
 */
export function project(
  accounts: readonly OverviewAccount[],
  perHour: number,
  now: number,
  horizonMs: number,
  useResets = false
): Projection {
  const sim: SimAccount[] = accounts
    .filter((account) => account.weeklyLeft !== null)
    .map((account) => ({
      left: (account.weeklyLeft ?? 0) * account.weight,
      cap: 100 * account.weight,
      refillAt: account.refillAtMs,
      resets: account.resets.map((ms) => ms ?? Infinity).sort((a, b) => a - b),
    }));
  const total = () => sim.reduce((sum, account) => sum + account.left, 0);
  const points: ForecastPoint[] = [{ t: now, remaining: total() }];
  const refills: Projection['refills'] = [];
  let dryAtMs: number | null = null;
  let resetsUsed = 0;

  for (let t = now + STEP_MS; t <= now + horizonMs; t += STEP_MS) {
    let gain = 0;
    for (const account of sim) {
      if (account.refillAt === null || account.refillAt > t) continue;
      gain += account.cap - account.left;
      account.left = account.cap;
      while (account.refillAt <= t) account.refillAt += WEEK_MS;
    }
    if (gain > 0) refills.push({ t, gain });
    drain(sim, (perHour * STEP_MS) / HOUR_MS);
    if (useResets) {
      for (const account of sim) {
        if (account.left > 0) continue;
        const index = account.resets.findIndex((expiry) => expiry > t);
        if (index === -1) continue;
        account.resets.splice(index, 1);
        account.left = account.cap;
        account.refillAt = t + WEEK_MS;
        resetsUsed += 1;
      }
    }
    const remaining = total();
    if (dryAtMs === null && remaining < 0.5) dryAtMs = t;
    points.push({ t, remaining });
  }
  return { points, refills, dryAtMs, resetsUsed };
}

/** Record a reading, skipping a repeat of the last one, and drop readings past the keep window. */
export function appendSnapshot(
  history: readonly PoolSnapshot[],
  snapshot: PoolSnapshot,
  repeatWithinMs = 10 * MINUTE_MS
): PoolSnapshot[] {
  const kept = history.filter((point) => point.t >= snapshot.t - HISTORY_KEEP_MS);
  const last = kept[kept.length - 1];
  const repeat =
    last !== undefined &&
    snapshot.t - last.t < repeatWithinMs &&
    Math.abs(last.remaining - snapshot.remaining) < 0.05 &&
    last.capacity === snapshot.capacity;
  return repeat ? kept : [...kept, snapshot];
}

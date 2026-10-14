/**
 * Pooled quota readings kept in this browser, one series per provider. The quota
 * APIs only report the present, so the forecast's past line and measured drain
 * rate come from readings recorded here whenever every account in a pool has
 * fresh quota.
 */

import { useEffect } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { appendSnapshot, type PoolSnapshot } from '../forecast';
import type { OverviewPool, OverviewProvider } from '../overview';

export type PoolHistory = Partial<Record<OverviewProvider, PoolSnapshot[]>>;

const STORAGE_KEY = 'cli-proxy-quota-pool-history-v1';

export function usePoolHistory(pools: readonly OverviewPool[]): PoolHistory {
  const [history, setHistory] = useLocalStorage<PoolHistory>(STORAGE_KEY, {});

  useEffect(() => {
    const ready = pools.filter((pool) => pool.complete && pool.capacity > 0);
    if (ready.length === 0) return;
    const t = Date.now();
    setHistory((prev) => {
      let next = prev;
      for (const pool of ready) {
        const series = prev[pool.provider] ?? [];
        const updated = appendSnapshot(series, {
          t,
          remaining: pool.remaining,
          capacity: pool.capacity,
        });
        const last = series.length - 1;
        if (updated.length === series.length && updated[last] === series[last]) continue;
        next = { ...next, [pool.provider]: updated };
      }
      return next;
    });
  }, [pools, setHistory]);

  return history;
}

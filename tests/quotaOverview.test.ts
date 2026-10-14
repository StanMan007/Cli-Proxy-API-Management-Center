import { describe, expect, test } from 'bun:test';
import type { QuotaFileEntry } from '@/features/quota/logic';
import { buildOverviewAccounts, nextRenewalMs, poolAccounts } from '@/features/quota/overview';
import type { QuotaCardState } from '@/features/quota/providers';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 14, 12);
const iso = (ms: number) => new Date(ms).toISOString();

const entry = (type: 'claude' | 'codex' | 'meta', name: string): QuotaFileEntry => ({
  type,
  file: { name, type },
});

const codex = (
  planType: string,
  weeklyUsed: number,
  refillIn: number,
  resetExpiries: number[] = []
): CodexQuotaState => ({
  status: 'success',
  planType,
  windows: [
    {
      id: 'weekly',
      label: 'Weekly',
      usedPercent: weeklyUsed,
      resetLabel: '',
      resetAtMs: NOW + refillIn,
    },
  ],
  rateLimitResetCredits: resetExpiries.map((ms, index) => ({
    id: `c${index}`,
    status: 'available',
    grantedAt: iso(NOW - DAY),
    expiresAt: iso(ms),
  })),
});

const claude = (weeklyUsed: number, fableUsed: number | null = null): ClaudeQuotaState => ({
  status: 'success',
  planType: 'plan_max',
  windows: [
    {
      id: 'five-hour',
      label: '5h',
      usedPercent: 10,
      resetLabel: '',
      resetAtMs: NOW + HOUR,
      periodHours: 5,
    },
    {
      id: 'seven-day',
      label: 'Weekly',
      usedPercent: weeklyUsed,
      resetLabel: '',
      resetAtMs: NOW + 3 * DAY,
      periodHours: 168,
    },
    ...(fableUsed === null
      ? []
      : [
          {
            id: 'seven-day-fable',
            label: 'Fable',
            usedPercent: fableUsed,
            resetLabel: '',
            resetAtMs: NOW + 3 * DAY,
            periodHours: 168,
          },
        ]),
  ],
});

const grant = (resetsLeft: number, endsAt: number): AnthropicResetGrant => ({
  id: 'g',
  label: 'Reset',
  resetsTotal: resetsLeft,
  resetsLeft,
  startsAt: null,
  endsAt: iso(endsAt),
  clears: [],
  paused: false,
  usableNow: true,
  useRequiresLimit: false,
  percentUsed: {},
});

const accountsFor = (
  quotas: Record<string, QuotaCardState>,
  entries: QuotaFileEntry[],
  grants: Record<string, AnthropicResetGrant[]> = {}
) => buildOverviewAccounts(entries, (e) => quotas[e.file.name], grants);

describe('quota overview', () => {
  test('pools Codex by plan weight and sorts the tightest account first', () => {
    const entries = [entry('codex', 'big'), entry('codex', 'small'), entry('meta', 'm')];
    const accounts = accountsFor(
      { big: codex('pro', 85, 5 * DAY), small: codex('prolite', 10, 2 * DAY) },
      entries
    );
    expect(accounts.map((a) => a.key)).toEqual(['big', 'small']);

    const pool = poolAccounts('codex', accounts);
    // Pro 200 (15% left) counts as two accounts: 15*2 + 90 of 200 + 100.
    expect(pool).toMatchObject({ remaining: 120, capacity: 300, complete: true });
    expect(pool.accounts[0].key).toBe('big');
    expect(pool.nextRefillMs).toBe(NOW + 2 * DAY);
  });

  test('leaves paused accounts out of the pooled totals without moving them', () => {
    const quotas = { tight: codex('pro', 90, DAY), live: codex('plus', 40, 3 * DAY) };
    const live = poolAccounts(
      'codex',
      accountsFor(quotas, [entry('codex', 'tight'), entry('codex', 'live')])
    );
    const paused = poolAccounts(
      'codex',
      accountsFor(quotas, [
        { ...entry('codex', 'tight'), file: { name: 'tight', type: 'codex', disabled: true } },
        entry('codex', 'live'),
      ])
    );
    expect(paused.accounts.map((a) => a.key)).toEqual(live.accounts.map((a) => a.key));
    expect(paused).toMatchObject({ remaining: 60, capacity: 100, nextRefillMs: NOW + 3 * DAY });
  });

  test('reads the 5-hour window and surfaces a narrower weekly one only when it binds first', () => {
    const [tight, loose] = accountsFor({ a: claude(40, 90), b: claude(40, 10) }, [
      entry('claude', 'a'),
      entry('claude', 'b'),
    ]);
    expect(tight.weeklyLeft).toBe(60);
    expect(tight).toMatchObject({ fiveHourLeft: 90, fiveHourResetMs: NOW + HOUR });
    expect(tight.tighter).toMatchObject({ label: 'Fable', left: 10 });
    expect(loose.tighter).toBeNull();
  });

  test('collects banked resets per account, one entry per reset, soonest expiry first', () => {
    const [cx, cl] = accountsFor(
      { cx: codex('pro', 0, 5 * DAY, [NOW + 20 * DAY, NOW + 2 * DAY]), cl: claude(0) },
      [entry('codex', 'cx'), entry('claude', 'cl')],
      { cl: [grant(2, NOW + 30 * DAY)] }
    );
    expect(cx.resets).toEqual([NOW + 2 * DAY, NOW + 20 * DAY]);
    expect(cl.resets).toEqual([NOW + 30 * DAY, NOW + 30 * DAY]);
  });
  test('renewal uses Codex paid-through dates and rolls Claude starts to the next anniversary', () => {
    expect(nextRenewalMs({ kind: 'until', atMs: NOW + 5 * DAY }, NOW)).toBe(NOW + 5 * DAY);
    expect(nextRenewalMs({ kind: 'until', atMs: NOW - DAY }, NOW)).toBeNull();
    // Started Mar 20, 2025 at 09:00; next anniversary after Oct 14, 2026 noon is Oct 20.
    expect(nextRenewalMs({ kind: 'monthly', sinceMs: Date.UTC(2025, 2, 20, 9) }, NOW)).toBe(
      Date.UTC(2026, 9, 20, 9)
    );
    // Same-day anniversary earlier than now has passed, so it rolls to next month.
    expect(nextRenewalMs({ kind: 'monthly', sinceMs: Date.UTC(2025, 2, 14, 9) }, NOW)).toBe(
      Date.UTC(2026, 10, 14, 9)
    );
    // A Jan 31 start renews on the last day of shorter months.
    const jan31 = Date.UTC(2026, 0, 31);
    expect(nextRenewalMs({ kind: 'monthly', sinceMs: jan31 }, Date.UTC(2026, 1, 10))).toBe(
      Date.UTC(2026, 1, 28)
    );
  });
});

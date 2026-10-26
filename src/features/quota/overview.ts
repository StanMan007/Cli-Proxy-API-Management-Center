/**
 * Quota overview model: turns per-credential quota state into compact account
 * rows and pooled per-provider totals.
 * React-free; consumed by QuotaOverview and tests/quotaOverview.test.ts.
 */

import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import type { ClaudeQuotaState, CodexQuotaState, DevinQuotaState, MetaQuotaState } from '@/types';
import {
  isDisabledAuthFile,
  normalizePlanType,
  parseIsoToMs,
  PREMIUM_CODEX_PLAN_TYPES,
  resolveResetMs,
} from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from './logic';
import type { QuotaCardState } from './providers';

/** Providers whose quota is a weekly window (plus an optional shorter one), so they pool. */
export const OVERVIEW_PROVIDERS = ['claude', 'codex', 'meta', 'devin'] as const;
export type OverviewProvider = (typeof OVERVIEW_PROVIDERS)[number];

export const isOverviewProvider = (type: string): type is OverviewProvider =>
  (OVERVIEW_PROVIDERS as readonly string[]).includes(type);

const HOUR_MS = 60 * 60 * 1000;
/** Below this much weekly quota left, an account's meter turns red. */
export const LOW_LEFT_PERCENT = 25;
/** Below this much left, an account's shorter window shows even while those windows are hidden. */
export const SESSION_LOW_LEFT_PERCENT = 20;
/** Resets that expire within this window are shown in amber before they are lost. */
export const EXPIRY_WARNING_MS = 7 * 24 * HOUR_MS;

export interface OverviewAccount {
  key: string;
  provider: OverviewProvider;
  entry: QuotaFileEntry;
  status: QuotaCardState['status'] | 'idle';
  /** i18n key for the plan, or the raw plan string when there is no key. */
  plan: { key: string } | { raw: string } | null;
  /** Relative plan size used to weight the pool (Codex Pro 200 counts as two Pro 100s). */
  weight: number;
  weeklyLeft: number | null;
  /**
   * The shorter rolling window under the weekly one (Claude and Codex 5 hours, Muse's
   * session window, Devin's day); null when the provider reports none. `hours` is null
   * when the window's length is unknown.
   */
  session: { left: number | null; resetMs: number | null; hours: number | null } | null;
  /** A narrower weekly window (e.g. a model-scoped one) that is tighter than the main one. */
  tighter: { labelKey?: string; label: string; left: number } | null;
  refillAtMs: number | null;
  /** Expiry instants of every reset still available, soonest first (null = no expiry known). */
  resets: (number | null)[];
  /** Codex and Devin report when the paid period ends; Claude only when the subscription began. */
  renewal: { kind: 'until'; atMs: number } | { kind: 'monthly'; sinceMs: number } | null;
}

export interface OverviewPool {
  provider: OverviewProvider;
  accounts: OverviewAccount[];
  /**
   * Weekly quota left summed across loaded, unpaused accounts (paused ones are out of
   * the gateway's rotation, so the fleet can't spend them), where one account's full week
   * is 100% (six Claude accounts pool to 600%; a Codex Pro 200 counts as 200%).
   */
  remaining: number;
  capacity: number;
  /** Every active account has fresh quota, so the totals are safe to record as history. */
  complete: boolean;
  nextRefillMs: number | null;
}

const clampPercent = (percent: number | null | undefined): number | null =>
  percent === null || percent === undefined ? null : Math.max(0, Math.min(100, percent));

const leftOf = (usedPercent: number | null | undefined): number | null =>
  usedPercent === null || usedPercent === undefined ? null : clampPercent(100 - usedPercent);

type AccountDetails = Omit<OverviewAccount, 'key' | 'provider' | 'entry' | 'status'>;

/**
 * Next subscription renewal after `now`. A monthly anchor rolls forward to its next
 * anniversary, clamped to short months (a Jan 31 start renews Feb 28); an end date
 * already past means the token is stale, so nothing is shown.
 */
export function nextRenewalMs(renewal: OverviewAccount['renewal'], now: number): number | null {
  if (!renewal) return null;
  if (renewal.kind === 'until') return renewal.atMs > now ? renewal.atMs : null;
  const start = new Date(renewal.sinceMs);
  const anniversary = (months: number) => {
    const year = start.getUTCFullYear();
    const month = start.getUTCMonth() + months;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(
      year,
      month,
      Math.min(start.getUTCDate(), lastDay),
      start.getUTCHours(),
      start.getUTCMinutes()
    );
  };
  const today = new Date(now);
  let months = Math.max(
    1,
    (today.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      today.getUTCMonth() -
      start.getUTCMonth()
  );
  while (anniversary(months) <= now) months++;
  return anniversary(months);
}

const sortResets = (resets: (number | null)[]) =>
  resets.sort((a, b) => (a ?? Infinity) - (b ?? Infinity));

function codexPlan(planType: string | null | undefined): Pick<OverviewAccount, 'plan' | 'weight'> {
  const normalized = normalizePlanType(planType);
  if (!normalized) return { plan: null, weight: 1 };
  if (normalized === 'pro') return { plan: { key: 'codex_quota.plan_pro' }, weight: 2 };
  if (normalized === 'self_serve_business_prolite')
    return { plan: { key: 'codex_quota.plan_business_premium' }, weight: 1 };
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized))
    return { plan: { key: 'codex_quota.plan_prolite' }, weight: 1 };
  if (['plus', 'team', 'free'].includes(normalized))
    return { plan: { key: `codex_quota.plan_${normalized}` }, weight: 1 };
  return { plan: { raw: planType || normalized }, weight: 1 };
}

function claudeAccount(
  quota: ClaudeQuotaState | undefined,
  grants: readonly AnthropicResetGrant[]
): AccountDetails {
  const windows = quota?.windows ?? [];
  const weekly = windows.find((window) => window.id === 'seven-day');
  const fiveHour = windows.find((window) => window.id === 'five-hour');
  const subscribedMs = parseIsoToMs(quota?.subscriptionCreatedAt);
  const weeklyLeft = leftOf(weekly?.usedPercent);
  // Model- or app-scoped weekly windows only matter when they bind before the main one.
  const tighter = windows
    .filter(
      (window) =>
        window.periodHours === 168 &&
        window.id !== 'seven-day' &&
        window.id !== 'cloud-session-credits'
    )
    .map((window) => ({
      labelKey: window.labelKey,
      label: window.label,
      left: leftOf(window.usedPercent),
    }))
    .filter((window): window is typeof window & { left: number } => window.left !== null)
    .filter((window) => weeklyLeft === null || window.left < weeklyLeft)
    .sort((a, b) => a.left - b.left)[0];
  return {
    plan: quota?.planType ? { key: `claude_quota.${quota.planType}` } : null,
    weight: 1,
    weeklyLeft,
    // Every Claude plan has a 5-hour window, so a loaded account always shows one.
    session: quota
      ? { left: leftOf(fiveHour?.usedPercent), resetMs: fiveHour?.resetAtMs ?? null, hours: 5 }
      : null,
    tighter: tighter ?? null,
    refillAtMs: weekly?.resetAtMs ?? null,
    resets: sortResets(
      grants.flatMap((grant) =>
        Array.from({ length: Math.max(0, grant.resetsLeft) }, () => parseIsoToMs(grant.endsAt))
      )
    ),
    renewal: subscribedMs === null ? null : { kind: 'monthly', sinceMs: subscribedMs },
  };
}

function codexAccount(quota: CodexQuotaState | undefined): AccountDetails {
  const windows = quota?.windows ?? [];
  const weekly = windows.find((window) => window.id === 'weekly');
  const fiveHour = windows.find((window) => window.id === 'five-hour');
  const paidUntilMs = resolveResetMs([quota?.subscriptionActiveUntil]);
  const fiveHourLeft = leftOf(fiveHour?.usedPercent);
  return {
    ...codexPlan(quota?.planType),
    weeklyLeft: leftOf(weekly?.usedPercent),
    session:
      fiveHourLeft === null
        ? null
        : { left: fiveHourLeft, resetMs: fiveHour?.resetAtMs ?? null, hours: 5 },
    tighter: null,
    refillAtMs: weekly?.resetAtMs ?? null,
    resets: sortResets(
      (quota?.rateLimitResetCredits ?? []).map((credit) => parseIsoToMs(credit.expiresAt))
    ),
    renewal: paidUntilMs === null ? null : { kind: 'until', atMs: paidUntilMs },
  };
}

function metaAccount(quota: MetaQuotaState | undefined): AccountDetails {
  const windows = quota?.data?.windows ?? [];
  const weekly = windows.find((window) => window.id === 'weekly');
  const session = windows.find((window) => window.id === 'window');
  const sessionLeft = leftOf(session?.usedPercent);
  // Muse reports reset instants in Unix seconds.
  const msOf = (seconds: number | undefined) => (seconds === undefined ? null : seconds * 1000);
  return {
    plan: quota?.data?.planName ? { raw: quota.data.planName } : null,
    weight: 1,
    weeklyLeft: leftOf(weekly?.usedPercent),
    session:
      sessionLeft === null
        ? null
        : {
            left: sessionLeft,
            resetMs: msOf(session?.resetAt),
            hours: session?.durationMinutes ? session.durationMinutes / 60 : null,
          },
    tighter: null,
    refillAtMs: msOf(weekly?.resetAt),
    resets: [],
    renewal: null,
  };
}

function devinAccount(quota: DevinQuotaState | undefined): AccountDetails {
  const windows = quota?.windows ?? [];
  const weekly = windows.find((window) => window.id === 'weekly');
  const daily = windows.find((window) => window.id === 'daily');
  const dailyLeft = clampPercent(daily?.remainingPercent);
  return {
    plan: quota?.plan ? { raw: quota.plan } : null,
    weight: 1,
    weeklyLeft: clampPercent(weekly?.remainingPercent),
    session:
      dailyLeft === null
        ? null
        : { left: dailyLeft, resetMs: daily?.resetAtMs ?? null, hours: daily?.periodHours ?? 24 },
    tighter: null,
    refillAtMs: weekly?.resetAtMs ?? null,
    resets: [],
    renewal: quota?.planEndMs ? { kind: 'until', atMs: quota.planEndMs } : null,
  };
}

/** Each overview provider's quota state, read into the shared account shape. */
const ACCOUNT_BUILDERS: {
  [P in OverviewProvider]: (
    quota: QuotaCardState | undefined,
    grants: readonly AnthropicResetGrant[]
  ) => AccountDetails;
} = {
  claude: (quota, grants) => claudeAccount(quota as ClaudeQuotaState | undefined, grants),
  codex: (quota) => codexAccount(quota as CodexQuotaState | undefined),
  meta: (quota) => metaAccount(quota as MetaQuotaState | undefined),
  devin: (quota) => devinAccount(quota as DevinQuotaState | undefined),
};

/** One row per credential of an overview provider; the rest are left to the detailed cards. */
export function buildOverviewAccounts(
  entries: readonly QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined,
  claudeGrants: Readonly<Record<string, readonly AnthropicResetGrant[]>>
): OverviewAccount[] {
  return entries.flatMap((entry): OverviewAccount[] => {
    const provider = entry.type;
    if (!isOverviewProvider(provider)) return [];
    const key = getQuotaCacheKey(entry.file);
    const quota = quotaFor(entry);
    const status = quota?.status ?? 'idle';
    const usable = status === 'success' || (status === 'loading' && quota !== undefined);
    const details = ACCOUNT_BUILDERS[provider](usable ? quota : undefined, claudeGrants[key] ?? []);
    return [{ key, provider, entry, status, ...details }];
  });
}

/**
 * True while an account has nothing to show yet: its first read is in flight, or the
 * page's first automatic load (`firstLoadPending`) is about to request it (that load
 * skips paused accounts). Its row holds a placeholder of the loaded shape instead of
 * "Not loaded".
 */
export const isAwaitingQuota = (account: OverviewAccount, firstLoadPending: boolean) =>
  account.weeklyLeft === null &&
  (account.status === 'loading' ||
    (firstLoadPending && account.status === 'idle' && !isDisabledAuthFile(account.entry.file)));

/**
 * Whether a row shows its shorter (5-hour, session or daily) window: always when they are
 * switched on, otherwise only once it is nearly spent and about to bind before the weekly one.
 */
export const showsSession = (account: Pick<OverviewAccount, 'session'>, showAll: boolean) =>
  account.session !== null &&
  (showAll || (account.session.left !== null && account.session.left < SESSION_LOW_LEFT_PERCENT));

/**
 * Pool a provider's accounts, lowest weekly-left first so the tight ones lead. Pausing
 * doesn't move a row: a paused account keeps its place and only leaves the totals.
 */
export function poolAccounts(
  provider: OverviewProvider,
  accounts: OverviewAccount[]
): OverviewPool {
  const isPaused = (account: OverviewAccount) => isDisabledAuthFile(account.entry.file);
  const mine = accounts
    .filter((account) => account.provider === provider)
    .sort((a, b) => (a.weeklyLeft ?? Infinity) - (b.weeklyLeft ?? Infinity));
  const active = mine.filter((account) => !isPaused(account));
  const loaded = active.filter((account) => account.weeklyLeft !== null);
  const refills = active
    .map((account) => account.refillAtMs)
    .filter((ms): ms is number => ms !== null);
  return {
    provider,
    accounts: mine,
    remaining: loaded.reduce((sum, account) => sum + (account.weeklyLeft ?? 0) * account.weight, 0),
    capacity: loaded.reduce((sum, account) => sum + 100 * account.weight, 0),
    complete: active.every((account) => account.status === 'success'),
    nextRefillMs: refills.length ? Math.min(...refills) : null,
  };
}

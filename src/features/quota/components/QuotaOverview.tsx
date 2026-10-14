/**
 * Quota overview: one compact row per account of every provider with a weekly
 * window (OVERVIEW_PROVIDERS), grouped by provider under its summed weekly quota,
 * then the pooled forecast chart. Everything else (session credits, credit
 * balances, other providers) stays in the detailed cards below.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { IconRefreshCw } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useCountUp } from '@/hooks/motion';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import type { ResolvedTheme } from '@/types';
import { formatRelativeInstant, isDisabledAuthFile } from '@/utils/quota';
import { DAY_MS } from '@/utils/time/durations';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { drainRate } from '../forecast';
import { usePoolHistory } from '../hooks/usePoolHistory';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import {
  buildOverviewAccounts,
  EXPIRY_WARNING_MS,
  isAwaitingQuota,
  isOverviewProvider,
  LOW_LEFT_PERCENT,
  nextRenewalMs,
  OVERVIEW_PROVIDERS,
  poolAccounts,
  type OverviewAccount,
  type OverviewPool,
} from '../overview';
import { QuotaForecast } from './QuotaForecast';
import { QuotaTimeline } from './QuotaTimeline';
import styles from './QuotaOverview.module.scss';

export type QuotaOverviewProps = {
  entries: QuotaFileEntry[];
  /** Credentials left out because the server retired them; they need a new login. */
  needsLoginCount: number;
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  /** The page's first automatic quota load hasn't started yet; unread rows hold placeholders. */
  firstLoadPending: boolean;
  now: number;
  resolvedTheme: ResolvedTheme;
  canUseActions: boolean;
  resettingKey: string | null;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onRefresh: (entry: QuotaFileEntry) => void;
  onReset: (entry: QuotaFileEntry) => void;
  /** Credentials whose enable/pause request is in flight. */
  pausingKeys: ReadonlySet<string>;
  /** Same switch as Auth Files' Enabled: off takes the credential out of rotation. */
  onSetEnabled: (entry: QuotaFileEntry, enabled: boolean) => void;
};

const toneFor = (left: number | null) =>
  left === null
    ? styles.toneNone
    : left < LOW_LEFT_PERCENT
      ? styles.toneLow
      : left < 50
        ? styles.toneMid
        : styles.toneHigh;

/** The address is the identity people recognize; fall back to the file name. */
const accountName = (entry: QuotaFileEntry) => entry.file.email?.trim() || entry.file.name;

const CHART_VIEWS = ['forecast', 'timeline'] as const;
type ChartView = (typeof CHART_VIEWS)[number];

const sortExpiries = (resets: readonly (number | null)[]) =>
  [...resets].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));

export function QuotaOverview(props: QuotaOverviewProps) {
  const {
    entries,
    needsLoginCount,
    quotaFor,
    firstLoadPending,
    now,
    resolvedTheme,
    canUseActions,
    resettingKey,
    detailsOpen,
    onToggleDetails,
    onRefresh,
    onReset,
    pausingKeys,
    onSetEnabled,
  } = props;
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage;
  const relative = useCallback(
    (ms: number) => formatRelativeInstant(ms, now, language),
    [now, language]
  );

  // Claude reset grants come from a separate read each row owns; rows report them here.
  const [claudeGrants, setClaudeGrants] = useState<Record<string, readonly AnthropicResetGrant[]>>(
    {}
  );
  const reportGrants = useCallback((key: string, grants: readonly AnthropicResetGrant[]) => {
    setClaudeGrants((prev) => {
      const current = prev[key];
      if (current === grants || ((current?.length ?? 0) === 0 && grants.length === 0)) return prev;
      return { ...prev, [key]: grants };
    });
  }, []);
  const accounts = useMemo(
    () => buildOverviewAccounts(entries, quotaFor, claudeGrants),
    [entries, quotaFor, claudeGrants]
  );
  const pools = useMemo(
    () =>
      OVERVIEW_PROVIDERS.map((provider) => poolAccounts(provider, accounts)).filter(
        (pool) => pool.accounts.length > 0
      ),
    [accounts]
  );
  const history = usePoolHistory(pools);
  // A pool with nothing loaded yet holds placeholders for its total and forecast.
  const pendingProviders = useMemo(
    () =>
      new Set(
        pools
          .filter(
            (pool) =>
              pool.capacity === 0 &&
              pool.accounts.some((account) => isAwaitingQuota(account, firstLoadPending))
          )
          .map((pool) => pool.provider)
      ),
    [pools, firstLoadPending]
  );
  const [chartView, setChartView] = useLocalStorage<ChartView>(
    'cli-proxy-quota-chart-view',
    'forecast'
  );
  // The timeline lists the same accounts in the same order, named by address like the rows.
  const timelineEntries = useMemo(
    () => pools.flatMap((pool) => pool.accounts.map((account) => account.entry)),
    [pools]
  );
  const displayNameFor = useCallback(
    (name: string) => {
      const match = timelineEntries.find((entry) => entry.file.name === name);
      return match ? accountName(match) : name;
    },
    [timelineEntries]
  );
  const others = useMemo(() => {
    const types = new Map<string, number>();
    entries.forEach((entry) => {
      if (isOverviewProvider(entry.type) || isDisabledAuthFile(entry.file)) return;
      types.set(entry.type, (types.get(entry.type) ?? 0) + 1);
    });
    return types;
  }, [entries]);
  const otherCount = [...others.values()].reduce((sum, count) => sum + count, 0);
  const otherNames = [...others.keys()].map((type) => getTypeLabel(t, type)).join(', ');

  const providerLabel = (provider: string) => getTypeLabel(t, provider);
  if (pools.length === 0) return null;

  return (
    <section className={styles.overview} aria-label={t('quota_overview.label')}>
      {pools.map((pool) => (
        <div key={pool.provider} className={styles.group}>
          <GroupHead
            pool={pool}
            iconSrc={getAuthFileIcon(pool.provider, resolvedTheme)}
            iconBackground={
              isThemeSurfaceIconProvider(pool.provider)
                ? getThemeSurfaceIconBackground(resolvedTheme)
                : undefined
            }
            label={providerLabel(pool.provider)}
            perHour={drainRate(pool.accounts, history[pool.provider] ?? [], now)?.perHour ?? null}
            relative={relative}
            pending={pendingProviders.has(pool.provider)}
          />
          <div className={`${styles.row} ${styles.columns}`} aria-hidden="true">
            <span>{t('quota_overview.col_account')}</span>
            <span>{t('quota_overview.col_enabled')}</span>
            <span>{t('quota_overview.col_weekly')}</span>
            <span>{t('quota_overview.col_resets')}</span>
          </div>
          {pool.accounts.map((account) => (
            <AccountRow
              key={account.key}
              account={account}
              quota={quotaFor(account.entry)}
              awaiting={isAwaitingQuota(account, firstLoadPending)}
              now={now}
              relative={relative}
              canUseActions={canUseActions}
              resetting={resettingKey === account.key}
              onRefresh={() => onRefresh(account.entry)}
              onReset={() => onReset(account.entry)}
              pausing={pausingKeys.has(account.key)}
              onSetEnabled={(enabled) => onSetEnabled(account.entry, enabled)}
              reportGrants={reportGrants}
            />
          ))}
        </div>
      ))}

      <div className={styles.chartView}>
        <div
          className={styles.viewSwitch}
          role="tablist"
          aria-label={t('quota_overview.view_label')}
        >
          {CHART_VIEWS.map((view) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={chartView === view}
              onClick={() => setChartView(view)}
            >
              {t(`quota_overview.view_${view}`)}
            </button>
          ))}
        </div>
        {chartView === 'timeline' ? (
          <div className={styles.timelinePanel}>
            <QuotaTimeline
              entries={timelineEntries}
              quotaFor={quotaFor}
              displayNameFor={displayNameFor}
              resolvedTheme={resolvedTheme}
              now={now}
            />
          </div>
        ) : (
          <QuotaForecast
            pools={pools}
            history={history}
            pendingProviders={pendingProviders}
            now={now}
            resolvedTheme={resolvedTheme}
            relative={relative}
          />
        )}
      </div>

      <div className={styles.footer}>
        <span>
          {otherCount > 0
            ? t('quota_overview.other_providers', { count: otherCount, names: otherNames })
            : t('quota_overview.details_note')}
          {needsLoginCount > 0 && (
            <>
              {' · '}
              <Link to="/auth-files" className={styles.footerLink}>
                {t('quota_overview.needs_login', { count: needsLoginCount })}
              </Link>
            </>
          )}
        </span>
        <button type="button" className={styles.pill} onClick={onToggleDetails}>
          {t(detailsOpen ? 'quota_overview.hide_details' : 'quota_overview.show_details')}
        </button>
      </div>
    </section>
  );
}

/** Provider name, its summed weekly quota in large type, and the pool's burn and next refill. */
function GroupHead({
  pool,
  iconSrc,
  iconBackground,
  label,
  perHour,
  relative,
  pending,
}: {
  pool: OverviewPool;
  iconSrc: string | null | undefined;
  iconBackground: string | undefined;
  label: string;
  perHour: number | null;
  relative: (ms: number) => string;
  pending: boolean;
}) {
  const { t } = useTranslation();
  // Counts up from the placeholder's 0 when the pool's first reads land, then tracks refreshes.
  const remaining = useCountUp(Math.round(pool.remaining));
  // Accounts that haven't loaded have no plan yet; their rows already say so.
  const planCounts = new Map<string, number>();
  pool.accounts.forEach((account) => {
    if (!account.plan) return;
    const plan = 'key' in account.plan ? t(account.plan.key) : account.plan.raw;
    planCounts.set(plan, (planCounts.get(plan) ?? 0) + 1);
  });
  const stats = [
    perHour !== null ? t('quota_overview.per_hour_short', { rate: perHour.toFixed(1) }) : null,
    pool.nextRefillMs !== null
      ? t('quota_overview.next_refill', { time: relative(pool.nextRefillMs) })
      : null,
  ].filter(Boolean);
  return (
    <div className={styles.groupHead}>
      <div className={styles.groupTitle}>
        {iconSrc && (
          <span
            className={styles.groupIcon}
            style={iconBackground ? { background: iconBackground } : undefined}
          >
            <img src={iconSrc} alt="" />
          </span>
        )}
        {label}
        <span className={styles.groupMeta}>
          {[
            t('quota_overview.accounts', { count: pool.accounts.length }),
            ...[...planCounts.entries()].map(([plan, count]) => `${count} ${plan}`),
          ].join(' · ')}
        </span>
      </div>
      <div className={styles.groupTotal}>
        {pending ? (
          <Skeleton width={150} height={38} rounded={8} />
        ) : (
          <span className={styles.big}>
            {pool.capacity > 0 ? `${remaining}%` : '--'}
            {pool.capacity > 0 && (
              <small>{t('quota_overview.forecast_of', { capacity: `${pool.capacity}%` })}</small>
            )}
          </span>
        )}
        <span className={styles.groupStats}>{stats.join(' · ')}</span>
      </div>
    </div>
  );
}

/** Banked resets for one account, one line per expiry day with a count and how long is left. */
function ResetList({
  resets,
  now,
  relative,
}: {
  resets: (number | null)[];
  now: number;
  relative: (ms: number) => string;
}) {
  const { t, i18n } = useTranslation();
  if (resets.length === 0)
    return <span className={styles.none}>{t('quota_overview.no_resets')}</span>;
  const dateOf = (ms: number) =>
    new Date(ms).toLocaleDateString(i18n.resolvedLanguage, { month: 'short', day: 'numeric' });
  // Resets granted together expire together; one line per expiry day, soonest first.
  const groups: { label: string; first: number | null; count: number }[] = [];
  for (const expiry of sortExpiries(resets)) {
    const label = expiry === null ? t('quota_overview.expiry_unknown') : dateOf(expiry);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.count++;
    else groups.push({ label, first: expiry, count: 1 });
  }
  return (
    <ul
      className={styles.resetList}
      aria-label={t('quota_overview.reset_count', { count: resets.length })}
    >
      {groups.map((group) => (
        <li
          key={group.label}
          className={
            group.first !== null && group.first - now <= EXPIRY_WARNING_MS
              ? styles.warnText
              : undefined
          }
        >
          <span className={styles.resetCount}>{group.count}×</span>
          {group.label}
          {group.first !== null && group.first > now && (
            <span className={styles.resetLeft}>{relative(group.first)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One quota window: its name and what's left on top, the bar underneath. */
function LimitWindow({
  label,
  left,
  when,
  minor = false,
}: {
  label: string;
  left: number | null;
  when: string | null;
  minor?: boolean;
}) {
  return (
    <div className={`${styles.window} ${minor ? styles.windowMinor : ''}`}>
      <div className={styles.windowHead}>
        <span className={styles.windowLabel}>{label}</span>
        <span className={styles.pct}>{left === null ? '—' : `${Math.round(left)}%`}</span>
        {when && <span className={styles.windowWhen}>{when}</span>}
      </div>
      <span className={styles.bar}>
        <i className={toneFor(left)} style={{ width: `${left ?? 0}%` }} />
      </span>
    </div>
  );
}

/** A quota window's shape with nothing in it yet, so a row keeps its height when quota lands. */
function WindowPlaceholder({ minor = false }: { minor?: boolean }) {
  return (
    <div className={`${styles.window} ${minor ? styles.windowMinor : ''}`}>
      <div className={styles.placeholderHead}>
        <Skeleton width={minor ? 96 : 132} height={12} rounded={4} />
      </div>
      <Skeleton height={minor ? 5 : 8} rounded={999} />
    </div>
  );
}

/** Stand-in while the credential list loads: the overview's layout with nothing in it yet. */
export function QuotaOverviewSkeleton() {
  const { t } = useTranslation();
  return (
    <section
      className={`${styles.overview} ${styles.overviewSkeleton}`}
      aria-label={t('quota_overview.label')}
      aria-busy="true"
    >
      {[0, 1].map((group) => (
        <div key={group} className={styles.group}>
          <div className={styles.groupHead}>
            <Skeleton width={180} height={20} rounded={6} />
            <Skeleton width={150} height={38} rounded={8} />
          </div>
          {[0, 1].map((row) => (
            <div key={row} className={styles.row}>
              <Skeleton width="70%" height={14} rounded={4} />
              <Skeleton width={36} height={20} rounded={999} />
              <div className={styles.limits}>
                <WindowPlaceholder />
                <WindowPlaceholder minor />
              </div>
              <Skeleton className={styles.resetsPlaceholder} width={84} height={12} rounded={4} />
            </div>
          ))}
        </div>
      ))}
      <Skeleton height={400} rounded={14} />
    </section>
  );
}

type AccountRowProps = {
  account: OverviewAccount;
  quota: QuotaCardState | undefined;
  /** Quota is on its way; the row holds placeholders instead of "Not loaded". */
  awaiting: boolean;
  now: number;
  relative: (ms: number) => string;
  canUseActions: boolean;
  resetting: boolean;
  onRefresh: () => void;
  onReset: () => void;
  pausing: boolean;
  onSetEnabled: (enabled: boolean) => void;
  reportGrants: (key: string, grants: readonly AnthropicResetGrant[]) => void;
};

function AccountRow(props: AccountRowProps) {
  const {
    account,
    quota,
    awaiting,
    now,
    relative,
    canUseActions,
    resetting,
    onRefresh,
    onReset,
    pausing,
    onSetEnabled,
    reportGrants,
  } = props;
  const { t, i18n } = useTranslation();
  const { entry, status } = account;
  const paused = isDisabledAuthFile(entry.file);
  const canRefresh = canUseActions && !paused;
  const loading = status === 'loading';
  const isClaude = entry.type === 'claude';
  const claudeReset = useClaudeResetGrants(
    entry.file,
    isClaude && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );
  const adapter = QUOTA_ADAPTERS[entry.type];
  const adapterResetAvailable =
    !isClaude &&
    status === 'success' &&
    quota !== undefined &&
    Boolean(adapter.resetQuota && adapter.canResetQuota?.(quota));
  const resetAction = isClaude
    ? claudeReset.blocked
      ? null
      : claudeReset.confirm
    : adapterResetAvailable && canRefresh && !resetting
      ? onReset
      : null;

  useEffect(() => {
    if (isClaude) reportGrants(account.key, claudeReset.grants);
  }, [isClaude, account.key, claudeReset.grants, reportGrants]);
  // Codex states its paid-through date; Claude's is the monthly anniversary of its start.
  const renewsAtMs = nextRenewalMs(account.renewal, now);
  const renewalEstimated = account.renewal?.kind === 'monthly';
  const planLabel = account.plan
    ? 'key' in account.plan
      ? t(account.plan.key)
      : account.plan.raw
    : null;
  const hasData = account.weeklyLeft !== null || account.session !== null;
  const sessionHours = account.session?.hours ?? null;
  const sessionLabel =
    sessionHours === null
      ? t('quota_overview.window_session')
      : sessionHours === 5
        ? t('quota_overview.window_five_hour')
        : t('quota_overview.window_hours', { hours: Math.round(sessionHours * 10) / 10 });
  // A row that mounted empty animates its quota in; one that mounted with quota stays still.
  const [startedEmpty] = useState(!hasData);
  // "Oct 19, 21:00 · in 5 days" for a window's next reset; null once it has passed.
  const when = (ms: number | null) =>
    ms !== null && ms > now
      ? `${new Date(ms).toLocaleString(i18n.resolvedLanguage, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })} · ${relative(ms)}`
      : null;

  return (
    <div
      className={`${styles.row} ${paused ? styles.paused : ''} ${startedEmpty && hasData ? styles.arrived : ''}`}
    >
      <div className={styles.account}>
        <div className={styles.accountLine}>
          <span className={styles.accountName} title={accountName(entry)}>
            {accountName(entry)}
          </span>
          {planLabel && (
            <span className={`${styles.badge} ${account.weight > 1 ? styles.badgeStrong : ''}`}>
              {planLabel}
            </span>
          )}
        </div>
        {paused ? (
          <span className={styles.note}>{t('quota_overview.paused')}</span>
        ) : (
          renewsAtMs !== null && (
            <span
              className={styles.note}
              title={[
                t('quota_overview.renews_on', {
                  date: new Date(renewsAtMs).toLocaleDateString(i18n.resolvedLanguage, {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  }),
                }),
                renewalEstimated ? t('quota_overview.renews_estimate_hint') : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              {t(renewalEstimated ? 'quota_overview.renews_about' : 'quota_overview.renews_in', {
                count: Math.ceil((renewsAtMs - now) / DAY_MS),
              })}
            </span>
          )
        )}
      </div>
      <span
        className={styles.toggle}
        title={t(paused ? 'quota_overview.paused_hint' : 'quota_overview.enabled_hint')}
      >
        <ToggleSwitch
          checked={!paused}
          onChange={onSetEnabled}
          ariaLabel={t('auth_files.card_toggle', { name: accountName(entry) })}
          disabled={!canUseActions || pausing}
        />
      </span>
      <div className={styles.limits} aria-busy={awaiting || undefined}>
        {hasData ? (
          <>
            <LimitWindow
              label={t('quota_overview.window_weekly')}
              left={account.weeklyLeft}
              when={when(account.refillAtMs)}
            />
            {account.session && (
              <LimitWindow
                minor
                label={sessionLabel}
                left={account.session.left}
                when={when(account.session.resetMs)}
              />
            )}
            {account.tighter && (
              <LimitWindow
                minor
                label={
                  account.tighter.labelKey ? t(account.tighter.labelKey) : account.tighter.label
                }
                left={account.tighter.left}
                when={when(account.refillAtMs)}
              />
            )}
          </>
        ) : status === 'error' ? (
          <span className={styles.errorText}>{t('quota_overview.load_failed')}</span>
        ) : awaiting ? (
          <>
            <WindowPlaceholder />
            <WindowPlaceholder minor />
          </>
        ) : (
          <span className={styles.none}>{t('quota_overview.not_loaded')}</span>
        )}
      </div>
      {awaiting ? (
        <Skeleton className={styles.resetsPlaceholder} width={84} height={12} rounded={4} />
      ) : (
        <ResetList resets={account.resets} now={now} relative={relative} />
      )}
      <span className={styles.rowActions}>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onRefresh}
          disabled={!canRefresh || loading || resetting || claudeReset.busy}
          title={t('auth_files.quota_refresh_hint')}
          aria-label={t('auth_files.quota_refresh_hint')}
        >
          <IconRefreshCw
            size={14}
            className={loading || resetting || claudeReset.busy ? styles.spinning : undefined}
          />
        </button>
        {/* Both providers confirm before spending; solid once the account is running low. */}
        {account.resets.length > 0 && (
          <button
            type="button"
            className={`${styles.chip} ${resetAction && hasData && (account.weeklyLeft ?? 100) < 50 ? styles.chipPrimary : ''}`}
            onClick={resetAction ?? undefined}
            disabled={resetAction === null}
          >
            {t('quota_overview.use_reset')}
          </button>
        )}
      </span>
    </div>
  );
}

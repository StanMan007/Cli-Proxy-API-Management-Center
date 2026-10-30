/**
 * API credits: each Ultra account's monthly API allowance, spent only through the
 * gateway's api-claude-* aliases. Renders nothing when the collector isn't running.
 * Shares the overview's look: a group head with the summed total over one row per account.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiCreditsApi, type ApiCreditAccount } from '@/services/api';
import { useAuthStore } from '@/stores';
import overview from './QuotaOverview.module.scss';
import styles from './ApiCredits.module.scss';

const DAY_MS = 86_400_000;

// Same thresholds as the overview: <25% left uses the failure color, <50% amber.
const toneFor = (percentLeft: number) =>
  percentLeft < 25 ? overview.toneLow : percentLeft < 50 ? overview.toneMid : overview.toneHigh;

export function ApiCredits({ now }: { now: number }) {
  const { t, i18n } = useTranslation();
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [accounts, setAccounts] = useState<ApiCreditAccount[] | null>(null);

  useEffect(() => {
    if (!connected) return;
    let current = true;
    apiCreditsApi.fetch().then(
      (next) => current && setAccounts(next),
      () => current && setAccounts(null)
    );
    return () => {
      current = false;
    };
  }, [connected]);

  if (!accounts?.length) return null;

  const money = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' });
  const day = new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' });
  const relative = new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' });
  const left = accounts.reduce((sum, account) => sum + account.remainingUsd, 0);
  const allowance = accounts.reduce((sum, account) => sum + account.allowanceUsd, 0);

  return (
    <section className={overview.overview} aria-label={t('api_credits.title')}>
      <div className={overview.group}>
        <div className={overview.groupHead}>
          <div className={overview.groupTitle}>
            {t('api_credits.title')}
            <span className={overview.groupMeta}>
              {t('quota_overview.accounts', { count: accounts.length })}
            </span>
          </div>
          <div className={overview.groupTotal}>
            <span className={overview.big}>
              {money.format(left)}
              <small>{t('api_credits.left_of', { allowance: money.format(allowance) })}</small>
            </span>
            <span className={overview.groupStats}>{t('api_credits.estimate_note')}</span>
          </div>
        </div>
        <div className={`${overview.row} ${styles.row} ${overview.columns}`} aria-hidden="true">
          <span>{t('api_credits.col_account')}</span>
          <span>{t('api_credits.col_left')}</span>
          <span>{t('api_credits.col_expires')}</span>
        </div>
        {accounts.map((account) => {
          const percentLeft =
            account.allowanceUsd > 0 ? (account.remainingUsd / account.allowanceUsd) * 100 : 0;
          const expires = new Date(account.cycleEnd);
          const daysLeft = Math.max(0, Math.ceil((expires.getTime() - now) / DAY_MS));
          return (
            <div key={account.name} className={`${overview.row} ${styles.row}`}>
              <div className={overview.account}>
                <div className={overview.accountLine}>
                  <span className={overview.accountName}>{account.email}</span>
                  <span className={overview.badge}>{account.org}</span>
                </div>
                {account.lastError && (
                  <span className={overview.errorText} title={account.lastError}>
                    {t('api_credits.failed', { count: account.failedRequests })}
                  </span>
                )}
              </div>
              <div className={overview.window}>
                <div className={overview.windowHead}>
                  <span className={overview.windowLabel}>{money.format(account.remainingUsd)}</span>
                  <span className={overview.windowWhen}>
                    {t('api_credits.spent', {
                      spent: money.format(account.spentUsd),
                      count: account.requests,
                    })}
                  </span>
                </div>
                <span className={overview.bar}>
                  <i className={toneFor(percentLeft)} style={{ width: `${percentLeft}%` }} />
                </span>
              </div>
              <div className={styles.expires}>
                <span>{day.format(expires)}</span>
                <span className={daysLeft <= 3 ? overview.warnText : styles.muted}>
                  {relative.format(daysLeft, 'day')}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

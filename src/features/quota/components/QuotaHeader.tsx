import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { getAuthFileIcon, getTypeLabel, type ResolvedTheme } from '@/features/authFiles/constants';
import type { QuotaTabId } from '../constants';
import type { QuotaProviderType } from '../providers/types';
import styles from './QuotaHeader.module.scss';

export type QuotaHeaderProps = {
  /** Providers that have credentials, in tab order; the switch hides when there is only one. */
  providers: readonly QuotaProviderType[];
  active: QuotaTabId;
  resolvedTheme: ResolvedTheme;
  onChange: (tab: QuotaTabId) => void;
  refreshing: boolean;
  disableControls: boolean;
  onRefreshAll: () => void;
};

/**
 * Quota page header: the title with a provider switch beside it (All / Claude / Codex /
 * Muse…), which narrows the whole page, and the ink "refresh all" pill on the right.
 *
 * 入场：两处 `data-reveal` 交给页面壳的 useRevealGroup 统一编排。
 */
export function QuotaHeader(props: QuotaHeaderProps) {
  const { providers, active, resolvedTheme, onChange, refreshing, disableControls, onRefreshAll } =
    props;
  const { t } = useTranslation();

  return (
    <header className={styles.header}>
      <div className={styles.titleRow} data-reveal>
        <h1 className={styles.title}>{t('quota_management.title')}</h1>
        {providers.length > 1 && (
          <div className={styles.switch} role="group" aria-label={t('auth_files.filter_all')}>
            {(['all', ...providers] as const).map((tab) => {
              const icon = tab === 'all' ? null : getAuthFileIcon(tab, resolvedTheme);
              return (
                <button
                  key={tab}
                  type="button"
                  aria-pressed={active === tab}
                  onClick={() => onChange(tab)}
                >
                  {icon && <img src={icon} alt="" />}
                  {tab === 'all' ? t('auth_files.filter_all') : getTypeLabel(t, tab)}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className={styles.actions} data-reveal>
        <button
          type="button"
          className={styles.primaryAction}
          onClick={onRefreshAll}
          disabled={disableControls || refreshing}
        >
          <IconRefreshCw size={14} className={refreshing ? styles.spinning : undefined} />
          {t('quota_management.refresh_all_credentials')}
        </button>
      </div>
    </header>
  );
}

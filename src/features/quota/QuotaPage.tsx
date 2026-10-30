/**
 * 额度查询页：总览（Claude/Codex 汇总 + 需关注 + 紧凑账号行）在上，
 * 提供商 tabs + 统一卡网格收在「详细卡片」开关后（默认收起）。
 *
 * 行为契约：
 * - 总览的 Claude/Codex 凭证每个会话代自动加载一次（仅未加载的），不轮询；
 *   其他提供商保持点击加载；Devin 首次可见时主动查询一次（排在总览之后）；
 * - cacheGeneration 会话隔离 + request-id 去重（见 useQuotaBatchLoader）；
 * - 文件列表变化后按 provider 剪枝额度缓存（已删文件不残留）；
 * - useHeaderRefresh 单槽位：本页唯一注册者，全局刷新 = 重取文件列表。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconSearch, IconX } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useRevealGroup } from '@/hooks/motion';
import { useAuthStore, useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { isDisabledAuthFile } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { QuotaHeader } from './components/QuotaHeader';
import { QuotaOverview, QuotaOverviewSkeleton } from './components/QuotaOverview';
import { QuotaCard } from './components/QuotaCard';
import { QuotaTimeline } from './components/QuotaTimeline';
import {
  CARD_ENTRANCE_BUDGET_MS,
  QUOTA_PAGE_SIZE,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaSortMode,
  type QuotaTabId,
} from './constants';
import {
  canRefreshQuotaAfterList,
  classifyQuotaFiles,
  filterEntriesByTab,
  filterEntriesBySearch,
  needsRelogin,
  paginate,
  sortQuotaEntries,
  type QuotaFileEntry,
} from './logic';
import { isOverviewProvider } from './overview';
import { nextRecoveryMs } from './resetSchedule';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import { useDevinQuotaAutoLoad } from './providers/devin/useDevinQuotaAutoLoad';
import { useQuotaActions } from './hooks/useQuotaActions';
import { useQuotaBatchLoader } from './hooks/useQuotaBatchLoader';
import { readQuotaUiState, writeQuotaUiState } from './uiState';
import styles from './QuotaPage.module.scss';

const SKELETON_CARD_COUNT = 6;

/**
 * Existing providers display filenames; Devin's card and timeline share an
 * identity-aware display label. Keep the filename fallback stable for memoization.
 */
const displayNameFor = (name: string) => name;

export function QuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<QuotaTabId>(() => readQuotaUiState()?.tab ?? 'all');
  const [sortMode, setSortMode] = useState<QuotaSortMode>(
    () => readQuotaUiState()?.sortMode ?? 'default'
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 页头入场级联（标题与提供商切换 → 动作，级差 70ms）
  const revealRef = useRevealGroup<HTMLDivElement>();

  const disableControls = connectionStatus !== 'connected';

  /* ---------- 文件列表 ---------- */

  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [filesGeneration, setFilesGeneration] = useState<number | null>(null);
  const listRequestRef = useRef(0);
  const loadFiles = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (connectionStatus !== 'connected') {
      setFiles([]);
      setFilesGeneration(null);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === listRequestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      if (!isCurrent()) return;
      setFiles(data?.files || []);
      setFilesGeneration(sessionGeneration);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

  useHeaderRefresh(loadFiles);

  useEffect(() => {
    void loadFiles();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFiles]);

  /* ---------- 额度缓存 ----------
   * 排在归类/排序之前：「最快恢复优先」要读它算排序键。 */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const pluginQuota = useQuotaStore((state) => state.pluginQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        plugin: pluginQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [
      antigravityQuota,
      claudeQuota,
      codexQuota,
      devinQuota,
      kimiQuota,
      metaQuota,
      pluginQuota,
      xaiQuota,
    ]
  );

  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  /* ---------- 归类 / 过滤 / 排序 / 分页 ---------- */

  // 总览需要分钟时钟；排序键只在「最快恢复优先」下读它。默认序下若也读，pageItems
  // 每分钟换一次身份，会反复空转下面那个「刷新全部」的 loading 下降沿 effect。
  const now = useNow();
  const sortNow = sortMode === 'default' ? 0 : now;

  const allEntries = useMemo(() => classifyQuotaFiles(files, { includeDisabled: true }), [files]);
  const entries = useMemo(
    () => allEntries.filter((entry) => !isDisabledAuthFile(entry.file)),
    [allEntries]
  );
  // The overview shows paused credentials so they can be switched back on there, but not
  // dead ones: those only count toward a "needs a new login" note. Auto-loading only
  // fetches the active entries.
  const liveEntries = useMemo(
    () => allEntries.filter((entry) => !needsRelogin(entry.file)),
    [allEntries]
  );
  // The header switch offers only providers with a credential to show; a remembered tab
  // whose credentials are all gone falls back to All.
  const switchProviders = useMemo(
    () => QUOTA_TAB_ORDER.filter((type) => liveEntries.some((entry) => entry.type === type)),
    [liveEntries]
  );
  const activeTab: QuotaTabId = tab !== 'all' && !switchProviders.includes(tab) ? 'all' : tab;
  const shownLiveEntries = useMemo(
    () => filterEntriesByTab(liveEntries, activeTab),
    [liveEntries, activeTab]
  );
  const overviewEntries = useMemo(
    () => entries.filter((entry) => isOverviewProvider(entry.type)),
    [entries]
  );
  const filteredEntries = useMemo(
    () => filterEntriesBySearch(filterEntriesByTab(entries, activeTab), search),
    [entries, activeTab, search]
  );
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    setPage(1);
  }, []);

  const resolveNextRecovery = useCallback(
    (entry: QuotaFileEntry) => nextRecoveryMs(entry.type, getQuota(entry), sortNow),
    [getQuota, sortNow]
  );
  // 排序在分页之前：否则「最快恢复」只在当前页内成立。
  const sortedEntries = useMemo(
    () => sortQuotaEntries(filteredEntries, sortMode, resolveNextRecovery),
    [filteredEntries, sortMode, resolveNextRecovery]
  );

  const { pageItems, currentPage, totalPages } = useMemo(
    () => paginate(sortedEntries, page, QUOTA_PAGE_SIZE),
    [sortedEntries, page]
  );

  const handleTabChange = useCallback((next: QuotaTabId) => {
    setTab(next);
    setPage(1);
    writeQuotaUiState({ tab: next });
  }, []);

  const handleSortModeChange = useCallback((next: string) => {
    setSortMode(next as QuotaSortMode);
    setPage(1);
    writeQuotaUiState({ sortMode: next as QuotaSortMode });
  }, []);

  const sortOptions = useMemo(
    () =>
      QUOTA_SORT_MODES.map((mode) => ({ value: mode, label: t(`quota_management.sort_${mode}`) })),
    [t]
  );

  // 剪枝：文件列表落定后，各 provider 缓存只保留仍存在的凭证（暂停的也保留，总览仍显示其最后读数）
  useEffect(() => {
    if (loading || error || filesGeneration !== sessionGeneration) return;
    const survivorsByType = new Map<QuotaProviderType, Set<string>>(
      QUOTA_TAB_ORDER.map((type) => [type, new Set<string>()])
    );
    allEntries.forEach((entry) =>
      survivorsByType.get(entry.type)?.add(getQuotaCacheKey(entry.file))
    );

    QUOTA_TAB_ORDER.forEach((type) => {
      const survivors = survivorsByType.get(type) ?? new Set<string>();
      const setQuota = getQuotaSetter(QUOTA_ADAPTERS[type]);
      setQuota((prev) => {
        const staleKeys = Object.keys(prev).filter((name) => !survivors.has(name));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        staleKeys.forEach((name) => delete next[name]);
        return next;
      });
    });
  }, [allEntries, error, filesGeneration, loading, sessionGeneration]);

  /* ---------- 加载与操作 ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);

  // Pausing a credential takes it out of the gateway's rotation, exactly like the
  // Enabled switch on Auth Files. Optimistic; reverts if the server refuses.
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [pausingKeys, setPausingKeys] = useState<ReadonlySet<string>>(new Set());
  const setCredentialEnabled = useCallback(
    async (file: AuthFileItem, enabled: boolean) => {
      const key = getQuotaCacheKey(file);
      if (disableControls || pausingKeys.has(key)) return;
      const applyDisabled = (disabled: boolean) =>
        setFiles((prev) => prev.map((f) => (getQuotaCacheKey(f) === key ? { ...f, disabled } : f)));
      setPausingKeys((prev) => new Set(prev).add(key));
      applyDisabled(!enabled);
      try {
        const res = await authFilesApi.setStatus(
          file.name,
          !enabled,
          String(file.authIndex ?? '').trim() || undefined
        );
        applyDisabled(res.disabled);
        showNotification(
          t(enabled ? 'auth_files.status_enabled_success' : 'auth_files.status_disabled_success', {
            name: file.email?.trim() || file.name,
          }),
          'success'
        );
      } catch (err: unknown) {
        applyDisabled(file.disabled === true);
        const message = err instanceof Error ? err.message : '';
        showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
      } finally {
        setPausingKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [disableControls, pausingKeys, showNotification, t]
  );

  const pendingRefreshRef = useRef<number | null>(null);
  const prevLoadingRef = useRef(loading);

  // 刷新全部：先重取文件列表，待其落定（loading 下降沿）再批量拉总览凭证 + 展开时的当前页
  const handleRefreshAll = useCallback(() => {
    if (disableControls) return;
    pendingRefreshRef.current = sessionGeneration;
    void loadFiles();
  }, [disableControls, loadFiles, sessionGeneration]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;

    const requestedSession = pendingRefreshRef.current;
    if (requestedSession === null) return;
    if (requestedSession !== sessionGeneration) {
      pendingRefreshRef.current = null;
      return;
    }
    if (loading || !wasLoading) return;

    pendingRefreshRef.current = null;
    if (
      canRefreshQuotaAfterList(
        requestedSession,
        sessionGeneration,
        filesGeneration,
        Boolean(error),
        disableControls
      )
    ) {
      const targets = new Map(
        [...overviewEntries, ...(detailsOpen ? pageItems : [])].map((entry) => [
          `${entry.type}:${getQuotaCacheKey(entry.file)}`,
          entry,
        ])
      );
      void loadQuota([...targets.values()]);
    }
  }, [
    detailsOpen,
    disableControls,
    error,
    filesGeneration,
    loading,
    loadQuota,
    overviewEntries,
    pageItems,
    sessionGeneration,
  ]);

  const autoLoadBlocked =
    disableControls ||
    loading ||
    batchLoading ||
    Boolean(error) ||
    filesGeneration !== sessionGeneration;

  // 总览自动加载：每个会话代一次，只拉尚未加载的 Claude/Codex 凭证。
  const [overviewLoadedGeneration, setOverviewLoadedGeneration] = useState<number | null>(null);
  useEffect(() => {
    if (autoLoadBlocked || overviewLoadedGeneration === sessionGeneration) return;
    setOverviewLoadedGeneration(sessionGeneration);
    const targets = overviewEntries.filter((entry) => getQuota(entry) === undefined);
    if (targets.length > 0) void loadQuota(targets);
  }, [
    autoLoadBlocked,
    getQuota,
    loadQuota,
    overviewEntries,
    overviewLoadedGeneration,
    sessionGeneration,
  ]);

  // 排在总览自动加载之后：批量加载器会丢弃并发调用。
  useDevinQuotaAutoLoad(
    pageItems,
    autoLoadBlocked || !detailsOpen || overviewLoadedGeneration !== sessionGeneration,
    loadQuota
  );

  const canUseActions = !disableControls && !loading && filesGeneration === sessionGeneration;

  /* ---------- 首屏卡片一次性级联入场 ----------
   * 首批数据渲染后立即翻转 cardsAnimated；已挂载的卡片在挂载时捕获过自己的
   * 延迟（QuotaCard 内 useState 初始化），后续切 tab/翻页/刷新新挂载的卡片
   * 拿到 null —— 不重播。 */

  const [cardsAnimated, setCardsAnimated] = useState(false);
  const enableCardEntrance = !cardsAnimated && !loading && pageItems.length > 0;
  useEffect(() => {
    if (enableCardEntrance) {
      setCardsAnimated(true);
    }
  }, [enableCardEntrance]);
  const cardEntranceDelay = (index: number): number | null => {
    if (!enableCardEntrance) return null;
    if (pageItems.length <= 1) return 0;
    return Math.round((index / (pageItems.length - 1)) * CARD_ENTRANCE_BUDGET_MS);
  };

  /* ---------- 渲染 ---------- */

  const isEmpty = !loading && filteredEntries.length === 0;
  // Until the first credential list arrives, hold the overview's layout rather than the
  // detailed cards' skeleton, which would vanish once the overview takes over. A remembered
  // tab for another provider keeps the cards' skeleton: that's what it will show.
  const showOverviewSkeleton =
    loading && files.length === 0 && !detailsOpen && (tab === 'all' || isOverviewProvider(tab));

  return (
    <div className={styles.page} ref={revealRef}>
      <QuotaHeader
        providers={switchProviders}
        active={activeTab}
        resolvedTheme={resolvedTheme}
        onChange={handleTabChange}
        refreshing={loading || batchLoading}
        disableControls={disableControls}
        onRefreshAll={handleRefreshAll}
      />

      {showOverviewSkeleton && <QuotaOverviewSkeleton />}
      <QuotaOverview
        entries={shownLiveEntries}
        needsLoginCount={filterEntriesByTab(allEntries, activeTab).length - shownLiveEntries.length}
        quotaFor={getQuota}
        firstLoadPending={
          overviewLoadedGeneration !== sessionGeneration && !disableControls && !error
        }
        now={now}
        resolvedTheme={resolvedTheme}
        canUseActions={canUseActions}
        resettingKey={resettingQuotaName}
        detailsOpen={detailsOpen}
        onToggleDetails={() => setDetailsOpen((open) => !open)}
        onRefresh={(entry) => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
        onReset={(entry) => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
        pausingKeys={pausingKeys}
        onSetEnabled={(entry, enabled) => void setCredentialEnabled(entry.file, enabled)}
      />


      {/* A provider with no overview group (Kimi, xAI…) shows its detailed cards directly. */}
      {(detailsOpen ||
        (!showOverviewSkeleton &&
          !shownLiveEntries.some((entry) => isOverviewProvider(entry.type)))) && (
        <section className={styles.workbench}>
          <div className={styles.toolbar}>
            <div className={styles.search}>
              <IconSearch size={16} className={styles.searchIcon} aria-hidden="true" />
              <input
                ref={searchInputRef}
                className={styles.searchInput}
                type="search"
                value={search}
                onChange={(event) => handleSearchChange(event.target.value)}
                placeholder={t('quota_management.search_placeholder')}
                aria-label={t('quota_management.search_label')}
              />
              {search && (
                <button
                  type="button"
                  className={styles.clearSearch}
                  aria-label={t('quota_management.search_clear')}
                  title={t('quota_management.search_clear')}
                  onClick={() => {
                    handleSearchChange('');
                    searchInputRef.current?.focus();
                  }}
                >
                  <IconX size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            <div className={styles.sort}>
              <Select
                value={sortMode}
                options={sortOptions}
                onChange={handleSortModeChange}
                ariaLabel={t('quota_management.sort_label')}
                size="sm"
              />
            </div>
          </div>

          {error && (
            <div className={styles.errorBanner} role="alert">
              {error}
            </div>
          )}

          {loading ? (
            <div className={styles.grid} aria-hidden="true">
              {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
                <Skeleton key={index} height={168} rounded={14} />
              ))}
            </div>
          ) : isEmpty ? (
            <EmptyState
              title={
                search.trim()
                  ? t('quota_management.search_empty_title')
                  : activeTab === 'all'
                    ? t('quota_management.empty_title')
                    : t(`${QUOTA_ADAPTERS[activeTab].i18nPrefix}.empty_title`)
              }
              description={
                search.trim()
                  ? t('quota_management.search_empty_desc')
                  : activeTab === 'all'
                    ? t('quota_management.empty_desc')
                    : t(`${QUOTA_ADAPTERS[activeTab].i18nPrefix}.empty_desc`)
              }
              action={
                search.trim() ? (
                  <Button variant="secondary" size="sm" onClick={() => handleSearchChange('')}>
                    {t('quota_management.search_clear')}
                  </Button>
                ) : activeTab === 'all' ? undefined : (
                  <Button variant="secondary" size="sm" onClick={() => handleTabChange('all')}>
                    {t('auth_files.filter_all')}
                  </Button>
                )
              }
            />
          ) : (
            <div className={styles.grid}>
              {pageItems.map((entry, index) => (
                <QuotaCard
                  key={`${entry.type}:${getQuotaCacheKey(entry.file)}`}
                  entry={entry}
                  quota={getQuota(entry)}
                  resolvedTheme={resolvedTheme}
                  canRefresh={canUseActions && !entry.file.disabled}
                  resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
                  entranceDelayMs={cardEntranceDelay(index)}
                  onRefresh={() => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                  onReset={() => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                />
              ))}
            </div>
          )}

          {!loading && filteredEntries.length > QUOTA_PAGE_SIZE && (
            <div className={styles.pagination}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage(Math.max(1, currentPage - 1))}
                disabled={currentPage <= 1}
              >
                {t('auth_files.pagination_prev')}
              </Button>
              <div className={styles.pageInfo}>
                {t('auth_files.pagination_info', {
                  current: currentPage,
                  total: totalPages,
                  count: filteredEntries.length,
                })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage >= totalPages}
              >
                {t('auth_files.pagination_next')}
              </Button>
            </div>
          )}

          {/* 时间线只比较当前页凭证，避免大量凭证一次性生成无界泳道。 */}
          <QuotaTimeline
            entries={pageItems}
            quotaFor={getQuota}
            displayNameFor={displayNameFor}
            resolvedTheme={resolvedTheme}
          />
        </section>
      )}
    </div>
  );
}

/**
 * Pooled quota forecast: one provider's summed weekly quota, how fast it is
 * draining, and a chart of recorded readings plus the projection forward
 * (with and without spending banked resets). All maths lives in ../forecast.ts.
 */

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconChevronUp } from '@/components/ui/icons';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import type { ResolvedTheme } from '@/types';
import { TYPE_COLORS } from '@/utils/quota';
import { DAY_MS } from '@/utils/time/durations';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { drainRate, project, type ForecastPoint } from '../forecast';
import type { PoolHistory } from '../hooks/usePoolHistory';
import type { OverviewPool, OverviewProvider } from '../overview';
import styles from './QuotaForecast.module.scss';

const RANGE_DAYS = [3, 7, 14] as const;
type RangeDays = (typeof RANGE_DAYS)[number];
/** Recorded readings shown left of "now". */
const PAST_MS = 2 * DAY_MS;

export type QuotaForecastProps = {
  pools: OverviewPool[];
  history: PoolHistory;
  now: number;
  resolvedTheme: ResolvedTheme;
  relative: (ms: number) => string;
};

const pct = (value: number) => `${Math.round(value)}%`;

export function QuotaForecast({
  pools,
  history,
  now,
  resolvedTheme,
  relative,
}: QuotaForecastProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage;
  const [selected, setSelected] = useState<OverviewProvider | null>(null);
  const [rangeDays, setRangeDays] = useLocalStorage<RangeDays>('cli-proxy-quota-forecast-range', 7);
  const [open, setOpen] = useLocalStorage('cli-proxy-quota-forecast-open', true);
  const pool = pools.find((candidate) => candidate.provider === selected) ?? pools[0];

  const model = useMemo(() => {
    if (!pool) return null;
    const series = history[pool.provider] ?? [];
    const rate = drainRate(pool.accounts, series, now);
    const horizon = rangeDays * DAY_MS;
    const base = rate ? project(pool.accounts, rate.perHour, now, horizon) : null;
    const banked = rate && pool.accounts.some((account) => account.resets.length > 0);
    const withResets = banked ? project(pool.accounts, rate.perHour, now, horizon, true) : null;
    const past: ForecastPoint[] = [
      ...series.filter((point) => point.t >= now - PAST_MS && point.t < now),
      { t: now, remaining: pool.remaining },
    ];
    return {
      rate,
      base,
      withResets: withResets && withResets.resetsUsed > 0 ? withResets : null,
      past,
      start: past[0].t,
      end: now + horizon,
    };
  }, [pool, history, now, rangeDays]);

  if (!pool || !model) return null;
  const { rate, base, withResets, past } = model;
  const colors = TYPE_COLORS[pool.provider] ?? TYPE_COLORS.unknown;
  const color = (resolvedTheme === 'dark' && colors.dark ? colors.dark : colors.light).text;
  const at = (ms: number) =>
    new Date(ms).toLocaleString(language, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const day = (ms: number) =>
    new Date(ms).toLocaleDateString(language, { month: 'short', day: 'numeric' });
  const outlook = (dryAtMs: number | null) =>
    dryAtMs === null
      ? t('quota_overview.forecast_lasts_past', { date: day(model.end) })
      : t('quota_overview.forecast_runs_dry', { time: relative(dryAtMs) });
  const nextRefill = base?.refills[0];

  return (
    <section className={styles.forecast} aria-label={t('quota_overview.forecast_label')}>
      <div className={styles.head}>
        {pools.length > 1 ? (
          <div className={styles.tabs} role="tablist">
            {pools.map((candidate) => {
              const iconSrc = getAuthFileIcon(candidate.provider, resolvedTheme);
              const active = candidate.provider === pool.provider;
              return (
                <button
                  key={candidate.provider}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`${styles.tab} ${active ? styles.tabActive : ''}`}
                  onClick={() => setSelected(candidate.provider)}
                >
                  {iconSrc && (
                    <span
                      className={styles.tabIcon}
                      style={
                        isThemeSurfaceIconProvider(candidate.provider)
                          ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                          : undefined
                      }
                    >
                      <img src={iconSrc} alt="" />
                    </span>
                  )}
                  {getTypeLabel(t, candidate.provider)}
                  <span className={styles.tabCount}>{candidate.accounts.length}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <span className={styles.title}>{getTypeLabel(t, pool.provider)}</span>
        )}
        <div className={styles.headRight}>
          {open && (
            <div className={styles.range} aria-label={t('quota_overview.forecast_range')}>
              {RANGE_DAYS.map((days) => (
                <button
                  key={days}
                  type="button"
                  aria-pressed={days === rangeDays}
                  className={days === rangeDays ? styles.rangeActive : undefined}
                  onClick={() => setRangeDays(days)}
                >
                  {t('quota_overview.forecast_days', { count: days })}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className={styles.collapse}
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            title={t(open ? 'quota_overview.forecast_hide' : 'quota_overview.forecast_show')}
            aria-label={t(open ? 'quota_overview.forecast_hide' : 'quota_overview.forecast_show')}
          >
            {open ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
          </button>
        </div>
      </div>

      <div className={styles.headline}>
        <span className={styles.big} style={{ color }}>
          {pct(pool.remaining)}
        </span>
        <span className={styles.of}>
          {t('quota_overview.forecast_of', { capacity: pct(pool.capacity) })}
        </span>
        {rate && (
          <span
            className={styles.stat}
            title={t(
              rate.source === 'history'
                ? 'quota_overview.forecast_rate_history'
                : 'quota_overview.forecast_rate_week'
            )}
          >
            {t('quota_overview.forecast_per_hour', { rate: rate.perHour.toFixed(1) })}
          </span>
        )}
        {base && (
          <span className={`${styles.stat} ${base.dryAtMs !== null ? styles.warn : ''}`}>
            {outlook(base.dryAtMs)}
          </span>
        )}
      </div>

      {open &&
        (base ? (
          <>
            <div className={styles.legend}>
              <span>
                <i className={styles.keySolid} style={{ background: color }} />
                {t('quota_overview.forecast_remaining')}
              </span>
              <span>
                <i className={styles.keyDashed} style={{ borderColor: color }} />
                {t('quota_overview.forecast_projected')}
              </span>
              {withResets && (
                <span>
                  <i className={styles.keyDotted} />
                  {t('quota_overview.forecast_with_resets')}
                </span>
              )}
            </div>
            <ForecastChart
              past={past}
              projected={base.points}
              withResets={withResets?.points ?? null}
              refills={base.refills}
              dryAtMs={base.dryAtMs}
              now={now}
              start={model.start}
              end={model.end}
              capacity={pool.capacity}
              color={color}
              at={at}
              day={day}
            />
          </>
        ) : (
          <div className={styles.empty}>{t('quota_overview.forecast_no_rate')}</div>
        ))}

      <div className={styles.foot}>
        <span>
          {nextRefill
            ? t('quota_overview.forecast_next_refill', {
                gain: pct(nextRefill.gain),
                time: at(nextRefill.t),
              })
            : pool.nextRefillMs !== null
              ? t('quota_overview.next_refill', { time: relative(pool.nextRefillMs) })
              : null}
        </span>
        {withResets ? (
          <span>
            {t('quota_overview.forecast_resets_outlook', { outlook: outlook(withResets.dryAtMs) })}
          </span>
        ) : (
          open && past.length < 2 && <span>{t('quota_overview.forecast_history_note')}</span>
        )}
      </div>
    </section>
  );
}

const HEIGHT = 220;
const PAD = { left: 46, right: 14, top: 18, bottom: 26 };

type ForecastChartProps = {
  past: ForecastPoint[];
  projected: ForecastPoint[];
  withResets: ForecastPoint[] | null;
  refills: { t: number; gain: number }[];
  dryAtMs: number | null;
  now: number;
  start: number;
  end: number;
  capacity: number;
  color: string;
  at: (ms: number) => string;
  day: (ms: number) => string;
};

function ForecastChart(props: ForecastChartProps) {
  const {
    past,
    projected,
    withResets,
    refills,
    dryAtMs,
    now,
    start,
    end,
    capacity,
    color,
    at,
    day,
  } = props;
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const all = [...past, ...projected, ...(withResets ?? [])];
  const yMax = Math.max(capacity, ...all.map((point) => point.remaining), 1);
  const x = (ms: number) => PAD.left + ((ms - start) / Math.max(1, end - start)) * plotW;
  const y = (value: number) => PAD.top + (1 - value / yMax) * plotH;
  const line = (points: ForecastPoint[]) =>
    points
      .map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.remaining).toFixed(1)}`)
      .join(' ');
  const area = (points: ForecastPoint[]) =>
    points.length < 2
      ? ''
      : `${line(points)} L${x(points[points.length - 1].t).toFixed(1)} ${y(0)} L${x(points[0].t).toFixed(1)} ${y(0)} Z`;

  const dayTicks = useMemo(() => {
    const ticks: number[] = [];
    const first = new Date(start);
    first.setHours(24, 0, 0, 0);
    const step = Math.max(1, Math.ceil((end - start) / DAY_MS / 6));
    for (let ms = first.getTime(); ms < end; ms += step * DAY_MS) ticks.push(ms);
    return ticks;
  }, [start, end]);

  const valueAt = (points: ForecastPoint[] | null, ms: number) => {
    if (!points?.length || ms < points[0].t || ms > points[points.length - 1].t) return null;
    let nearest = points[0];
    for (const point of points)
      if (Math.abs(point.t - ms) < Math.abs(nearest.t - ms)) nearest = point;
    return nearest.remaining;
  };
  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const left = event.currentTarget.getBoundingClientRect().left;
    const ms = start + ((event.clientX - left - PAD.left) / Math.max(1, plotW)) * (end - start);
    setHover(ms < start || ms > end ? null : ms);
  };
  const hoverValue =
    hover === null ? null : (valueAt(hover <= now ? past : projected, hover) ?? null);
  const hoverResets = hover === null || hover <= now ? null : valueAt(withResets, hover);

  return (
    <div ref={boxRef} className={styles.chart}>
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={t('quota_overview.forecast_label')}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line
                className={styles.grid}
                x1={PAD.left}
                x2={PAD.left + plotW}
                y1={y(f * yMax)}
                y2={y(f * yMax)}
              />
              <text className={styles.axis} x={PAD.left - 8} y={y(f * yMax) + 4} textAnchor="end">
                {pct(f * yMax)}
              </text>
            </g>
          ))}
          {dayTicks.map((ms) => (
            <text key={ms} className={styles.axis} x={x(ms)} y={HEIGHT - 6} textAnchor="middle">
              {day(ms)}
            </text>
          ))}

          <path d={area(past)} fill={`url(#${gradientId})`} />
          <path d={area(projected)} fill={`url(#${gradientId})`} opacity={0.45} />
          {withResets && <path className={styles.resetsLine} d={line(withResets)} />}
          <path
            d={line(projected)}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeDasharray="6 5"
          />
          {past.length > 1 && (
            <path
              d={line(past)}
              fill="none"
              stroke={color}
              strokeWidth={2.5}
              strokeLinejoin="round"
            />
          )}

          <line className={styles.now} x1={x(now)} x2={x(now)} y1={PAD.top - 6} y2={y(0)} />
          <text className={styles.axis} x={x(now) + 6} y={PAD.top - 4}>
            {t('quota_overview.forecast_now')}
          </text>
          <circle cx={x(now)} cy={y(past[past.length - 1].remaining)} r={4} fill={color} />
          {refills.map((refill) => (
            <g key={refill.t}>
              <title>{`+${pct(refill.gain)} · ${at(refill.t)}`}</title>
              <circle
                className={styles.refill}
                cx={x(refill.t)}
                cy={y(valueAt(projected, refill.t) ?? 0)}
                r={3.5}
                stroke={color}
              />
            </g>
          ))}
          {dryAtMs !== null && <circle className={styles.dry} cx={x(dryAtMs)} cy={y(0)} r={4} />}

          {hover !== null && hoverValue !== null && (
            <line className={styles.guide} x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={y(0)} />
          )}
        </svg>
      )}
      {hover !== null && hoverValue !== null && (
        <div
          className={styles.tooltip}
          style={{
            left: Math.min(Math.max(x(hover), 70), width - 70),
          }}
        >
          <span>{at(hover)}</span>
          <b>{pct(hoverValue)}</b>
          {hoverResets !== null && Math.round(hoverResets) !== Math.round(hoverValue) && (
            <span>{t('quota_overview.forecast_tooltip_resets', { value: pct(hoverResets) })}</span>
          )}
        </div>
      )}
    </div>
  );
}

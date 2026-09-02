import { useEffect, useMemo, useState } from 'react';
import type { DashboardMode, DataManifest, DashboardHealth, DominanceFilter, ExpiryScope, Language, PriceChartMode, PriceTimeframe, WallMode, WallSegment } from './domain/types';
import { FRONT_TARGET_DTES } from './domain/front-equivalent';
import { wallExpiryState } from './domain/wall-status';
import { loadDashboardData } from './data/loaders';
import OIWallChart from './components/OIWallChart';
import SeriesDetails from './components/SeriesDetails';
import StatusBanner from './components/StatusBanner';
import ThaiGoldPanel from './components/ThaiGoldPanel';
import PredictionPanel from './components/PredictionPanel';
import DataStatusPanel from './components/DataStatusPanel';
import { t } from './i18n';

const EMPTY_HEALTH: DashboardHealth = {
  state: 'error',
  generatedAt: new Date(0).toISOString(),
  lastSuccessAt: null,
  lastAttemptAt: null,
  stale: true,
  partial: false,
  auth: { state: 'unknown', checkedAt: null, message: null },
  price: { state: 'error', lastSuccessAt: null, message: 'กำลังโหลดข้อมูล' },
  oi: { state: 'error', lastSuccessAt: null, message: 'กำลังโหลดข้อมูล' },
  notes: [],
};

const DOMINANCE_FILTERS: Array<[DominanceFilter, string]> = [
  ['all', 'All'],
  ['call', 'Call-led'],
  ['put', 'Put-led'],
  ['balanced', 'Balanced'],
];
const MAX_WALL_STRENGTH = 20;
const MIN_OI_FILTER = 1_000;
const MAX_OI_FILTER = 10_000;
const OI_FILTER_STEP = 500;
const OI_FILTER_TICKS = [1_000, 2_500, 5_000, 7_500, 10_000];
type DashboardView = 'chart' | 'details' | 'status';
type ProjectionHorizonDays = 30 | 60 | 90;
const DEFAULT_DASHBOARD_MODE: DashboardMode = 'thai';

function wallOiForFilter(wall: Pick<WallSegment, 'callOi' | 'putOi' | 'totalOi'>, wallMode: WallMode) {
  if (wallMode === 'call') return wall.callOi;
  if (wallMode === 'put') return wall.putOi;
  return wall.totalOi;
}

function formatOiLabel(value: number) {
  return value >= 1_000 ? `${value / 1_000}K` : value.toLocaleString();
}

function dominanceFilterLabel(value: DominanceFilter, language: Language) {
  if (value === 'all') return t(language, 'allWalls');
  if (value === 'call') return t(language, 'callOnly');
  if (value === 'put') return t(language, 'putOnly');
  return language === 'th' ? 'สมดุล' : 'Balanced';
}

export default function App() {
  const [dashboardMode, setDashboardMode] = useState<DashboardMode>(DEFAULT_DASHBOARD_MODE);
  const [language, setLanguage] = useState<Language>(() => {
    const stored = window.localStorage.getItem('gold-sight-language');
    return stored === 'en' ? 'en' : 'th';
  });
  const [timeframe, setTimeframe] = useState<PriceTimeframe>('1D');
  const [priceMode, setPriceMode] = useState<PriceChartMode>('close');
  const [wallMode, setWallMode] = useState<WallMode>('combined');
  const [expiryScope, setExpiryScope] = useState<ExpiryScope>('front');
  const [timezone, setTimezone] = useState('Asia/Bangkok');
  const [showProjection, setShowProjection] = useState(true);
  const [projectionHorizonDays, setProjectionHorizonDays] = useState<ProjectionHorizonDays>(90);
  const [showForecastRange, setShowForecastRange] = useState(false);
  const [showDominanceProjection, setShowDominanceProjection] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dashboardView, setDashboardView] = useState<DashboardView>('chart');
  const [minWallStrength, setMinWallStrength] = useState(1);
  const [minWallOi, setMinWallOi] = useState(MIN_OI_FILTER);
  const [dominanceFilter, setDominanceFilter] = useState<DominanceFilter>('all');
  const [showExpiredWalls, setShowExpiredWalls] = useState(false);
  const [showMixedExpiryWalls, setShowMixedExpiryWalls] = useState(false);
  const [frontDtes, setFrontDtes] = useState<number[]>([...FRONT_TARGET_DTES]);
  const [data, setData] = useState<Awaited<ReturnType<typeof loadDashboardData>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isFutureMode = dashboardMode === 'futures';
  const activeModeHelp = isFutureMode ? t(language, 'futureModeHelp') : t(language, 'thaiModeHelp');

  useEffect(() => {
    window.localStorage.setItem('gold-sight-language', language);
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const next = await loadDashboardData(timeframe);
        if (!cancelled) { setData(next); setError(null); }
      } catch (reason: unknown) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        running = false;
      }
    };
    void refresh();
    const interval = window.setInterval(refresh, 5 * 60 * 1000);
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [timeframe]);

  const manifest: DataManifest | null = data?.manifest ?? null;
  const health = useMemo(() => {
    const base = manifest?.health ?? EMPTY_HEALTH;
    if (!data || !manifest) return base;
    const now = Date.now();
    const latestClosed = data.price
      .filter((bar) => bar.isClosed)
      .sort((a, b) => Date.parse(a.closeTime) - Date.parse(b.closeTime))
      .at(-1);
    const maxPriceAgeHours = timeframe === '1D' ? 72 : 12;
    const priceAgeHours = latestClosed ? (now - Date.parse(latestClosed.closeTime)) / 3_600_000 : Number.POSITIVE_INFINITY;
    const priceStale = !Number.isFinite(priceAgeHours) || priceAgeHours > maxPriceAgeHours;
    const oiEnd = manifest.coverage.oi.end;
    let oiBusinessDayLag = 0;
    if (oiEnd) {
      const cursor = new Date(`${oiEnd}T00:00:00.000Z`);
      const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      while (cursor < today) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) oiBusinessDayLag += 1;
      }
    }
    const oiStale = !oiEnd || oiBusinessDayLag > 2;
    if (!priceStale && !oiStale) return base;
    const price = priceStale
      ? { ...base.price, state: 'stale' as const, message: `${base.price.message ?? 'Price data'} · ${Number.isFinite(priceAgeHours) ? priceAgeHours.toFixed(1) : 'n/a'}h old` }
      : base.price;
    const oi = oiStale
      ? { ...base.oi, state: 'stale' as const, message: base.oi.message?.includes('business-day lag') ? base.oi.message : `${base.oi.message ?? 'OI data'} · ${oiBusinessDayLag} business-day lag` }
      : base.oi;
    return { ...base, state: 'partial' as const, stale: true, partial: true, price, oi };
  }, [data, manifest, timeframe]);
  const selectedWalls = expiryScope === 'all' ? data?.allExpiryWalls ?? [] : data?.walls ?? [];
  const wallReferenceTime = useMemo(() => {
    const latestPriceTime = (data?.price ?? []).reduce((latest, bar) => {
      const time = Date.parse(bar.time);
      return Number.isFinite(time) ? Math.max(latest, time) : latest;
    }, 0);
    return Math.max(latestPriceTime, Date.now());
  }, [data]);
  const filteredWalls = useMemo(() => selectedWalls.filter((wall) => {
    const expiryState = wallExpiryState(wall, wallReferenceTime);
    if (!showExpiredWalls && expiryState === 'expired') return false;
    if (!showMixedExpiryWalls && expiryState === 'mixed') return false;
    if (wallOiForFilter(wall, wallMode) < minWallOi) return false;
    if (wallMode === 'call' && wall.callOi <= 0) return false;
    if (wallMode === 'put' && wall.putOi <= 0) return false;
    if (wall.significanceScore < minWallStrength) return false;
    if (dominanceFilter === 'call' && wall.dominance < 0.15) return false;
    if (dominanceFilter === 'put' && wall.dominance > -0.15) return false;
    if (dominanceFilter === 'balanced' && (wall.dominance < -0.15 || wall.dominance > 0.15)) return false;
    if (expiryScope === 'front' && frontDtes.length < FRONT_TARGET_DTES.length && !frontDtes.some((dte) => wall.targetDtes.includes(dte))) return false;
    return true;
  }), [dominanceFilter, expiryScope, frontDtes, minWallOi, minWallStrength, selectedWalls, showExpiredWalls, showMixedExpiryWalls, wallMode, wallReferenceTime]);
  const resetWallFilters = () => {
    setMinWallStrength(1);
    setMinWallOi(MIN_OI_FILTER);
    setDominanceFilter('all');
    setShowExpiredWalls(false);
    setShowMixedExpiryWalls(false);
    setFrontDtes([...FRONT_TARGET_DTES]);
  };
  const toggleFrontDte = (dte: number) => {
    setFrontDtes((current) => {
      const next = current.length === FRONT_TARGET_DTES.length
        ? [dte]
        : current.includes(dte)
          ? current.filter((value) => value !== dte)
          : [...current, dte].sort((a, b) => a - b);
      return next.length > 0 ? next : [...FRONT_TARGET_DTES];
    });
  };
  const title = t(language, 'appTitle');
  const coverageLabel = useMemo(() => {
    if (!manifest) return 'กำลังโหลด coverage';
    const dailyEnd = manifest.datasets.price_1d?.coverageEnd ?? manifest.coverage.price.end?.slice(0, 10) ?? '—';
    const intradayEnd = manifest.datasets.price_4h?.coverageEnd ?? manifest.coverage.price.end?.slice(0, 10) ?? '—';
    return '1D ' + dailyEnd + ' · 4H ' + intradayEnd;
  }, [manifest]);
  const oiCoverageLabel = useMemo(() => {
    const start = manifest?.coverage.oi?.start ?? '—';
    const end = manifest?.coverage.oi?.end ?? '—';
    return `${start} → ${end}`;
  }, [manifest]);
  const oiExpiryLabel = useMemo(() => {
    const start = manifest?.coverage.oiExpiry?.start ?? '—';
    const end = manifest?.coverage.oiExpiry?.end ?? '—';
    return `${start} → ${end}`;
  }, [manifest]);

  const chartWindowLabel = useMemo(() => {
    const latestTime = (data?.price ?? []).filter((bar) => bar.isClosed).reduce((latest, bar) => {
      const time = Date.parse(bar.time);
      return Number.isFinite(time) ? Math.max(latest, time) : latest;
    }, Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(latestTime)) return '— → —';
    const latestDate = new Date(latestTime);
    return `${latestDate.getUTCFullYear()}-06-01 → ${latestDate.toISOString().slice(0, 10)}`;
  }, [data]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <div className="eyebrow">SIGNIFICANT COMBINED OI WALLS · {expiryScope === 'all' ? 'ALL EXPIRIES' : 'FRONT-EQUIVALENT COMPOSITE'} · $5 BASIS GRID</div>
          <h1>{title}</h1>
          <p className="subtitle">{t(language, 'appSubtitle')}</p>
        </div>
        <div className="header-meta">
          <span className="instrument-pill">{isFutureMode ? 'BLACKBULL:GOLD.F' : t(language, 'sourceOfficialShort')}</span>
          <span className="coverage">{isFutureMode ? 'Chart window' : t(language, 'mode')}: {isFutureMode ? chartWindowLabel : activeModeHelp}</span>
          <span className="coverage">{language === 'th' ? `ราคา ${coverageLabel}` : `Price ${coverageLabel}`}</span>
          <span className="coverage">{language === 'th' ? `ข้อมูล OI: ${oiCoverageLabel}` : `OI data: ${oiCoverageLabel}`}</span>
          <span className="coverage">{language === 'th' ? `สัญญาหมดอายุ (Expiry): ${oiExpiryLabel}` : `OI expiry: ${oiExpiryLabel}`}</span>
        </div>
      </header>

      <StatusBanner
        health={health}
        language={language}
        mode={dashboardMode}
        onViewStatus={() => setDashboardView('status')}
      />

      <section className="mode-switcher" aria-label={t(language, 'mode')}>
        <div className="control-group mode-control">
          <span className="control-label">{t(language, 'mode')}</span>
          <div className="segmented wide">
            {([
              ['futures', t(language, 'futures')],
              ['thai', t(language, 'thaiGold')],
            ] as Array<[DashboardMode, string]>).map(([value, label]) => (
              <button key={value} className={dashboardMode === value ? 'active' : ''} onClick={() => setDashboardMode(value)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="control-group language-switcher">
          <span className="control-label">{t(language, 'language')}</span>
          <div className="segmented">
            <button className={language === 'th' ? 'active' : ''} onClick={() => setLanguage('th')}>{t(language, 'thai')}</button>
            <button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>{t(language, 'english')}</button>
          </div>
        </div>
        <p className="mode-help">{activeModeHelp}</p>
      </section>

      {isFutureMode ? (<>
      <section className="control-bar" aria-label={t(language, 'view')}>
        <div className="control-group">
          <span className="control-label">{t(language, 'price')}</span>
          <div className="segmented">
            {(['1D', '4H'] as PriceTimeframe[]).map((item) => (
              <button key={item} className={timeframe === item ? 'active' : ''} onClick={() => setTimeframe(item)}>{item}</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">{t(language, 'priceBasis')}</span>
          <div className="segmented">
            <button className={priceMode === 'close' ? 'active' : ''} onClick={() => setPriceMode('close')}>{t(language, 'normal')}</button>
            <button className={priceMode === 'mean' ? 'active' : ''} onClick={() => setPriceMode('mean')}>{t(language, 'mean')}</button>
          </div>
          <small className="control-help">Mean = OHLC4 · ไม่ใช่ moving average</small>
        </div>
        <div className="control-group">
          <span className="control-label">{t(language, 'projection')}</span>
          <div className="segmented">
            <button className={showProjection ? 'active' : ''} onClick={() => setShowProjection(true)}>{t(language, 'on')}</button>
            <button className={!showProjection ? 'active' : ''} onClick={() => setShowProjection(false)}>{t(language, 'off')}</button>
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">{t(language, 'forecastHorizon')}</span>
          <div className="segmented">
            {([30, 60, 90] as ProjectionHorizonDays[]).map((days) => (
              <button key={days} className={projectionHorizonDays === days ? 'active' : ''} onClick={() => setProjectionHorizonDays(days)}>{days}D</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">{t(language, 'confidenceRange')}</span>
          <div className="segmented">
            <button className={showForecastRange ? 'active' : ''} onClick={() => setShowForecastRange(true)}>{t(language, 'on')}</button>
            <button className={!showForecastRange ? 'active' : ''} onClick={() => setShowForecastRange(false)}>{t(language, 'off')}</button>
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">{t(language, 'dominanceOutlook')}</span>
          <div className="segmented">
            <button className={showDominanceProjection ? 'active' : ''} onClick={() => setShowDominanceProjection(true)}>{t(language, 'on')}</button>
            <button className={!showDominanceProjection ? 'active' : ''} onClick={() => setShowDominanceProjection(false)}>{t(language, 'off')}</button>
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">{t(language, 'wallMode')}</span>
          <div className="segmented wide">
            {([
              ['combined', t(language, 'combined')],
              ['call', t(language, 'callOnly')],
              ['put', t(language, 'putOnly')],
              ['split', t(language, 'split')],
            ] as Array<[WallMode, string]>).map(([value, label]) => (
              <button key={value} className={wallMode === value ? 'active' : ''} onClick={() => setWallMode(value)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">{t(language, 'expiryScope')}</span>
          <div className="segmented wide">
            {([
              ['front', t(language, 'frontEquivalent')],
              ['all', t(language, 'allExpiries')],
            ] as Array<[ExpiryScope, string]>).map(([value, label]) => (
              <button key={value} className={expiryScope === value ? 'active' : ''} onClick={() => setExpiryScope(value)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <span className="control-label">{t(language, 'view')}</span>
          <div className="segmented">
            <button className={dashboardView === 'chart' ? 'active' : ''} onClick={() => setDashboardView('chart')}>{t(language, 'chart')}</button>
            <button className={dashboardView === 'details' ? 'active' : ''} onClick={() => setDashboardView('details')}>{t(language, 'seriesDetails')}</button>
            <button className={dashboardView === 'status' ? 'active' : ''} onClick={() => setDashboardView('status')}>{t(language, 'status')}</button>
          </div>
        </div>
        <label className="control-group timezone-control">
          <span className="control-label">{t(language, 'timezone')}</span>
          <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
            <option value="Asia/Bangkok">{t(language, 'bangkok')}</option>
            <option value="America/Chicago">{t(language, 'chicago')}</option>
            <option value="UTC">{t(language, 'utc')}</option>
          </select>
        </label>
      </section>

      </>) : (
        <section className="control-bar thai-control-bar" aria-label={t(language, 'view')}>
          <div className="control-group">
            <span className="control-label">{t(language, 'projection')}</span>
            <div className="segmented">
              <button className={showProjection ? 'active' : ''} onClick={() => setShowProjection(true)}>{t(language, 'on')}</button>
              <button className={!showProjection ? 'active' : ''} onClick={() => setShowProjection(false)}>{t(language, 'off')}</button>
            </div>
          </div>
          <div className="control-group">
            <span className="control-label">{t(language, 'forecastHorizon')}</span>
            <div className="segmented">
              {([30, 60, 90] as ProjectionHorizonDays[]).map((days) => (
                <button key={days} className={projectionHorizonDays === days ? 'active' : ''} onClick={() => setProjectionHorizonDays(days)}>{days}D</button>
              ))}
            </div>
          </div>
          <div className="control-group">
            <span className="control-label">{t(language, 'confidenceRange')}</span>
            <div className="segmented">
              <button className={showForecastRange ? 'active' : ''} onClick={() => setShowForecastRange(true)}>{t(language, 'on')}</button>
              <button className={!showForecastRange ? 'active' : ''} onClick={() => setShowForecastRange(false)}>{t(language, 'off')}</button>
            </div>
          </div>
          <div className="control-group">
            <span className="control-label">{t(language, 'dominanceOutlook')}</span>
            <div className="segmented">
              <button className={showDominanceProjection ? 'active' : ''} onClick={() => setShowDominanceProjection(true)}>{t(language, 'on')}</button>
              <button className={!showDominanceProjection ? 'active' : ''} onClick={() => setShowDominanceProjection(false)}>{t(language, 'off')}</button>
            </div>
          </div>
          <div className="control-group">
            <span className="control-label">{t(language, 'wallMode')}</span>
            <div className="segmented wide">
              {([
                ['combined', t(language, 'combined')],
                ['call', t(language, 'callOnly')],
                ['put', t(language, 'putOnly')],
                ['split', t(language, 'split')],
              ] as Array<[WallMode, string]>).map(([value, label]) => (
                <button key={value} className={wallMode === value ? 'active' : ''} onClick={() => setWallMode(value)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="control-group">
            <span className="control-label">{t(language, 'expiryScope')}</span>
            <div className="segmented wide">
              {([
                ['front', t(language, 'frontEquivalent')],
                ['all', t(language, 'allExpiries')],
              ] as Array<[ExpiryScope, string]>).map(([value, label]) => (
                <button key={value} className={expiryScope === value ? 'active' : ''} onClick={() => setExpiryScope(value)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="control-group">
            <span className="control-label">{t(language, 'view')}</span>
            <div className="segmented">
              <button className={dashboardView === 'chart' ? 'active' : ''} onClick={() => setDashboardView('chart')}>{t(language, 'chart')}</button>
              <button className={dashboardView === 'details' ? 'active' : ''} onClick={() => setDashboardView('details')}>{t(language, 'seriesDetails')}</button>
              <button className={dashboardView === 'status' ? 'active' : ''} onClick={() => setDashboardView('status')}>{t(language, 'status')}</button>
            </div>
          </div>
          <label className="control-group timezone-control">
            <span className="control-label">{t(language, 'timezone')}</span>
            <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
              <option value="Asia/Bangkok">{t(language, 'bangkok')}</option>
              <option value="America/Chicago">{t(language, 'chicago')}</option>
              <option value="UTC">{t(language, 'utc')}</option>
            </select>
          </label>
        </section>
      )}

      <details className="filter-panel filter-panel-collapsible" open={filtersOpen} onToggle={(event) => setFiltersOpen(event.currentTarget.open)}>
        <summary className="filter-summary-row">
          <div>
            <span className="control-label">{t(language, 'noiseFilters')}</span>
            <span className="filter-summary-hint">{t(language, filtersOpen ? 'filtersOpenHint' : 'filtersClosedHint')}</span>
          </div>
          <div className="filter-summary">
            <span><strong>{filteredWalls.length}</strong> / {selectedWalls.length} {t(language, 'wallCount')}</span>
            <button
              type="button"
              className="reset-button"
              onClick={(event) => { event.preventDefault(); event.stopPropagation(); resetWallFilters(); }}
            >{t(language, 'reset')}</button>
            <span className="filter-chevron" aria-hidden="true">⌄</span>
          </div>
        </summary>
        <div className="filter-panel-body">
          <p className="filter-description">{t(language, expiryScope === 'front' ? 'filterFrontDescription' : 'filterAllDescription')}</p>
        <div className="filter-grid">
          <div className="filter-control">
            <span className="control-label">{t(language, 'minWallStrength')}</span>
            <div className="range-row">
              <input
                className="range-input"
                type="range"
                min="1"
                max={MAX_WALL_STRENGTH}
                step="0.25"
                value={minWallStrength}
                aria-label="Minimum wall strength"
                aria-valuetext={minWallStrength <= 1 ? t(language, 'allSignificant') : `${minWallStrength.toFixed(2)}× threshold or stronger`}
                onChange={(event) => setMinWallStrength(Number(event.target.value))}
              />
              <span className="filter-value">{minWallStrength <= 1 ? t(language, 'allSignificant') : `≥ ${minWallStrength.toFixed(2)}×`}</span>
            </div>
            <small>{language === 'th' ? 'ปรับขึ้นเพื่อซ่อนแนวที่อ่อนกว่าเกณฑ์รายวัน' : 'Raise to hide weaker daily walls'}</small>
          </div>
          <div className="filter-control oi-slicer">
            <div className="slicer-heading">
              <span className="control-label">{t(language, 'minOi')}</span>
              <span className="filter-value">≥ {minWallOi.toLocaleString()}</span>
            </div>
            <div className="slicer-range">
              <span className="slicer-bound">1K</span>
              <input
                className="range-input"
                type="range"
                min={MIN_OI_FILTER}
                max={MAX_OI_FILTER}
                step={OI_FILTER_STEP}
                value={minWallOi}
                list="oi-filter-ticks"
                aria-label="Minimum open interest"
                aria-valuetext={`${wallMode === 'call' ? t(language, 'callOi') : wallMode === 'put' ? t(language, 'putOi') : t(language, 'totalOi')} ≥ ${minWallOi.toLocaleString()}`}
                onChange={(event) => setMinWallOi(Number(event.target.value))}
              />
              <span className="slicer-bound">10K</span>
              <datalist id="oi-filter-ticks">
                {OI_FILTER_TICKS.map((value) => <option key={value} value={value} label={formatOiLabel(value)} />)}
              </datalist>
            </div>
            <div className="slicer-ticks" aria-hidden="true">
              {OI_FILTER_TICKS.map((value) => <span key={value}>{formatOiLabel(value)}</span>)}
            </div>
            <small>{wallMode === 'call' ? t(language, 'callOi') : wallMode === 'put' ? t(language, 'putOi') : t(language, 'totalOi')} · {t(language, 'oiFilterHelp')}</small>
          </div>
          <div className="filter-control">
            <span className="control-label">{t(language, 'dominanceFilter')}</span>
            <div className="segmented wide">
              {DOMINANCE_FILTERS.map(([value]) => (
                <button key={value} className={dominanceFilter === value ? 'active' : ''} onClick={() => setDominanceFilter(value)}>{dominanceFilterLabel(value, language)}</button>
              ))}
            </div>
            <small>{t(language, 'dominanceHelp')}</small>
          </div>
          <div className="filter-control">
            <span className="control-label">{t(language, 'expiredWalls')}</span>
            <div className="segmented wide">
              <button className={!showExpiredWalls ? 'active' : ''} onClick={() => setShowExpiredWalls(false)}>{t(language, 'hideExpired')}</button>
              <button className={showExpiredWalls ? 'active' : ''} onClick={() => setShowExpiredWalls(true)}>{t(language, 'showExpired')}</button>
            </div>
            <small>{t(language, 'expiredHelp')}</small>
          </div>
          <div className="filter-control">
            <span className="control-label">{t(language, 'mixedWalls')}</span>
            <div className="segmented wide">
              <button className={!showMixedExpiryWalls ? 'active' : ''} onClick={() => setShowMixedExpiryWalls(false)}>{t(language, 'hideMixed')}</button>
              <button className={showMixedExpiryWalls ? 'active' : ''} onClick={() => setShowMixedExpiryWalls(true)}>{t(language, 'showMixed')}</button>
            </div>
            <small>{t(language, 'mixedHelp')}</small>
          </div>
          {expiryScope === 'front' ? (
            <div className="filter-control">
              <span className="control-label">{t(language, 'frontDte')}</span>
              <div className="segmented wide">
                <button className={frontDtes.length === FRONT_TARGET_DTES.length ? 'active' : ''} onClick={() => setFrontDtes([...FRONT_TARGET_DTES])}>{t(language, 'allWalls')}</button>
                {FRONT_TARGET_DTES.map((dte) => (
                  <button key={dte} className={frontDtes.includes(dte) && frontDtes.length < FRONT_TARGET_DTES.length ? 'active' : ''} onClick={() => toggleFrontDte(dte)}>{dte}D</button>
                ))}
              </div>
              <small>{t(language, 'dteHelp')}</small>
            </div>
          ) : null}
        </div>
        </div>
      </details>

      {dashboardView === 'status' ? (
        <DataStatusPanel
          manifest={manifest}
          health={health}
          expirySeries={data?.expirySeries ?? null}
          walls={filteredWalls}
          price={data?.price ?? []}
          thaiGold={data?.thaiGold ?? null}
          language={language}
          displayTimezone={timezone}
        />
      ) : dashboardView === 'details' ? (
        error ? (
          <div className="details-panel"><div className="details-empty">{error}</div></div>
        ) : data ? (
          <SeriesDetails
            walls={filteredWalls}
            expirySeries={data.expirySeries}
            wallMode={wallMode}
            expiryScope={expiryScope}
            displayTimezone={timezone}
            referenceTime={wallReferenceTime}
          />
        ) : (
          <div className="details-panel"><div className="details-empty">Loading series details…</div></div>
        )
      ) : isFutureMode ? (<>
        <section className="chart-card">
        {error ? (
          <div className="empty-state">
            <strong>ยังโหลดข้อมูลไม่ได้</strong>
            <span>{error}</span>
            <span>ตรวจสอบว่า public/data มี manifest และ dataset แล้ว</span>
          </div>
        ) : data ? (
          <OIWallChart
            price={data.price}
            walls={filteredWalls}
            rolls={data.rolls}
            timeframe={timeframe}
            priceMode={priceMode}
            wallMode={wallMode}
            displayTimezone={timezone}
            showProjection={showProjection}
            projectionHorizonDays={projectionHorizonDays}
            showForecastRange={showForecastRange}
            dominanceOutlook={data.dominanceOutlook}
            optionsPrediction={data.optionsPrediction}
            showDominanceProjection={showDominanceProjection}
          />
        ) : (
          <div className="empty-state"><strong>กำลังโหลด chart…</strong></div>
        )}
        </section>

        {data?.optionsPrediction ? <PredictionPanel prediction={data.optionsPrediction} language={language} unit="usd" /> : null}

        <section className="legend-grid">
          <div className="legend-card"><span className="legend-line price-line" /><div><strong>{priceMode === 'mean' ? 'Mean price (OHLC4)' : 'Futures close'}</strong><small>เส้นสีเหลือง · {priceMode === 'mean' ? 'ค่าเฉลี่ย Open/High/Low/Close ต่อจุด' : 'ราคาปิดจริงของแต่ละจุด'} · line chart ไม่มี OHLC candle</small></div></div>
          <div className="legend-card"><span className="legend-line call-line" /><div><strong>Call dominance</strong><small>สีเขียว · wall ยังไม่หมดอายุและ dominance เป็นบวก</small></div></div>
          <div className="legend-card"><span className="legend-line put-line" /><div><strong>Put dominance</strong><small>สีแดง · wall ยังไม่หมดอายุและ dominance เป็นลบ</small></div></div>
          <div className="legend-card"><span className="legend-line balanced-line" /><div><strong>Balanced Call / Put</strong><small>สีขาว · dominance ใกล้สมดุลภายใน ±15%</small></div></div>
          <div className="legend-card"><span className="legend-line high-oi-line" /><div><strong>High OI wall</strong><small>เส้นหนา · OI ตาม Wall mode ตั้งแต่ 10,000 ขึ้นไป</small></div></div>
          <div className="legend-card"><span className="legend-line roll-line" /><div><strong>Contract roll</strong><small>เส้นประแนวตั้งจาก expiry/roll metadata</small></div></div>
          <div className="legend-card"><span className="legend-line projection-line" /><div><strong>Projected price</strong><small>เส้นประสีส้ม · rolling-origin weighted ensemble guide ไม่ใช่ราคาจริง</small></div></div>
          <div className="legend-card"><span className="legend-line projection-band-line" /><div><strong>Forecast error band</strong><small>แถบสีส้มจาง · empirical 80th-percentile backtest error ที่ขยายตามเวลา ไม่ใช่ guaranteed confidence interval</small></div></div>
          <div className="legend-card"><span className="legend-line options-scenario-line" /><div><strong>Options-aware scenario</strong><small>เส้นฟ้า · historical ensemble ที่ปรับด้วย Max Pain และ Black-76 OI Greeks</small></div></div>
          <div className="legend-card"><span className="legend-line max-pain-line" /><div><strong>90D composite pain heuristic</strong><small>เส้นส้มแนวนอน · aggregate ภายใน horizon; scenario ใช้ Max Pain ของ expiry ใกล้สุดเป็น anchor หลัก</small></div></div>
          <div className="legend-card"><span className="legend-line gamma-flip-line" /><div><strong>Gamma flip</strong><small>เส้นฟ้าจุด · ระดับที่ net Gamma exposure เปลี่ยนเครื่องหมาย</small></div></div>
          <div className="legend-card"><span className="legend-line dominance-projection-line" /><div><strong>Dominance expiry-decay outlook</strong><small>เส้นจุดสีม่วง · carry-forward OI แล้วตัดสัญญาเมื่อหมดอายุ ไม่ได้ทำนายการเปิด/ปิดสถานะใหม่</small></div></div>
          <div className="legend-card"><span className="legend-line expired-line" /><div><strong>Expired wall</strong><small>สีเทา · expiry ผ่านแล้ว ณ เวลาปัจจุบัน</small></div></div>
          <div className="legend-card"><span className="legend-line mixed-line" /><div><strong>Mixed expiry wall</strong><small>สีเหลืองอมส้ม · wall รวม series ที่หมดและยังไม่หมดอายุ</small></div></div>
        </section>
      </>) : (
        <>
          <ThaiGoldPanel
            data={data?.thaiGold ?? null}
            walls={filteredWalls}
            wallMode={wallMode}
            language={language}
            displayTimezone={timezone}
            showProjection={showProjection}
            projectionHorizonDays={projectionHorizonDays}
            showForecastRange={showForecastRange}
            dominanceOutlook={data?.dominanceOutlook ?? null}
            optionsPrediction={data?.optionsPrediction ?? null}
            showDominanceProjection={showDominanceProjection}
          />
          {data?.optionsPrediction ? <PredictionPanel prediction={data.optionsPrediction} language={language} unit="thb" usdThb={data.thaiGold?.points.at(-1)?.usdThb} /> : null}
        </>
      )}

      <footer className="app-footer">
        <span>OI source: standalone CME Vol2Vol tenor + EOD options chain · {expiryScope === 'all' ? 'all listed expiries' : 'front target DTE 7/15/30/60/90'} · close → mid → open</span>
        <span>{health.lastSuccessAt ? `Last success ${new Date(health.lastSuccessAt).toLocaleString()}` : 'No successful collection yet'}</span>
      </footer>
    </main>
  );
}

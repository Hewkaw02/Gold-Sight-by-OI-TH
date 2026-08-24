import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';
import type { DominanceOutlook, Language, OptionsPrediction, PriceBar, ThaiGoldData, ThaiGoldPoint, WallMode, WallSegment } from '../domain/types.js';
import { t } from '../i18n.js';
import { calculateThaiGoldPrice } from '../domain/thai-gold.js';
import { wallExpiryEndTime, wallExpiryState } from '../domain/wall-status.js';
import { buildPriceProjection } from '../domain/price-projection.js';

interface ThaiGoldPanelProps {
  data: ThaiGoldData | null;
  walls: WallSegment[];
  wallMode: WallMode;
  language: Language;
  displayTimezone: string;
  showProjection: boolean;
  projectionHorizonDays: number;
  showForecastRange: boolean;
  dominanceOutlook: DominanceOutlook | null;
  optionsPrediction: OptionsPrediction | null;
  showDominanceProjection: boolean;
}

const ACTUAL_SELL = '#facc15';
const ACTUAL_BUY = '#5eead4';
const CALCULATED = '#fb923c';
const PREMIUM = '#c084fc';
const GREEN = '#5eead4';
const RED = '#fb7185';
const EXPIRED_WALL = '#64748b';
const MIXED_WALL = '#f59e0b';
const BALANCED_WALL = '#f8fafc';
const HIGH_OI_THRESHOLD = 10_000;
const BALANCED_DOMINANCE_LIMIT = 0.15;

function formatBaht(value: number | null | undefined, language: Language, maximumFractionDigits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(language === 'th' ? 'th-TH' : 'en-US', { maximumFractionDigits }).format(value);
}

function formatPct(value: number | null | undefined, language: Language) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

function formatDate(value: string, language: Language, timezone: string) {
  return new Intl.DateTimeFormat(language === 'th' ? 'th-TH' : 'en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function latestPoint(data: ThaiGoldData | null): ThaiGoldPoint | null {
  return data?.points.at(-1) ?? null;
}

function oiForWall(wall: WallSegment, wallMode: WallMode) {
  if (wallMode === 'call') return wall.callOi;
  if (wallMode === 'put') return wall.putOi;
  return wall.totalOi;
}

function wallWidth(totalOi: number, maxOi: number, emphasize: boolean) {
  if (maxOi <= 0) return 1;
  const base = 1.2 + Math.min(5, (totalOi / maxOi) * 5);
  return emphasize ? Math.min(8, Math.max(base + 1.75, 4.5)) : base;
}

function wallColor(wall: WallSegment, expiryState: ReturnType<typeof wallExpiryState>, side: 'call' | 'put' | 'combined') {
  if (expiryState === 'expired') return EXPIRED_WALL;
  if (expiryState === 'mixed') return MIXED_WALL;
  if (Math.abs(wall.dominance) <= BALANCED_DOMINANCE_LIMIT) return BALANCED_WALL;
  if (side === 'call') return GREEN;
  if (side === 'put') return RED;
  return wall.dominance > 0 ? GREEN : RED;
}

function wallChartEnd(wall: WallSegment) {
  const observedEnd = Date.parse(wall.to);
  const expiryEnd = wallExpiryEndTime(wall);
  if (wall.status !== 'active') return Number.isFinite(observedEnd) ? observedEnd : 0;
  return Math.max(Number.isFinite(observedEnd) ? observedEnd : 0, expiryEnd ?? 0);
}

function usdThbAt(points: ThaiGoldPoint[], timestamp: number) {
  const first = points[0]?.usdThb;
  if (!Number.isFinite(first)) return null;
  let rate = first;
  for (const point of points) {
    const pointTime = Date.parse(point.time);
    if (!Number.isFinite(pointTime) || pointTime > timestamp) break;
    rate = point.usdThb;
  }
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function wallThaiData(wall: WallSegment, points: ThaiGoldPoint[], chartStart: number, chartEnd: number) {
  const rawStart = Date.parse(wall.from);
  const rawEnd = Math.min(wallChartEnd(wall), chartEnd);
  const start = Math.max(Number.isFinite(rawStart) ? rawStart : chartStart, chartStart);
  if (!Number.isFinite(start) || !Number.isFinite(rawEnd) || start >= rawEnd) return null;
  const times = [
    start,
    ...points
      .map((point) => Date.parse(point.time))
      .filter((time) => Number.isFinite(time) && time > start && time < rawEnd),
    rawEnd,
  ];
  const data = times.map((time) => {
    const rate = usdThbAt(points, time);
    return rate === null ? null : [time, calculateThaiGoldPrice(wall.strike, rate)];
  }).filter((value): value is [number, number] => value !== null);
  return data.length >= 2 ? data : null;
}

function toThaiProjectionBars(points: ThaiGoldPoint[]): PriceBar[] {
  return points.map((point) => ({
    time: point.time,
    closeTime: point.time,
    symbol: 'THAI_GOLD',
    timeframe: '1D',
    open: point.actualSell,
    high: point.actualSell,
    low: point.actualSell,
    close: point.actualSell,
    volume: null,
    source: point.source,
    sourceTimezone: 'Asia/Bangkok',
    isClosed: true,
  }));
}

function convertOptionsPredictionToThai(prediction: OptionsPrediction, usdThb: number): OptionsPrediction {
  const convert = (value: number | null) => value === null ? null : calculateThaiGoldPrice(value, usdThb);
  return {
    ...prediction,
    underlyingPrice: calculateThaiGoldPrice(prediction.underlyingPrice, usdThb),
    maxPain: {
      ...prediction.maxPain,
      compositeStrike: convert(prediction.maxPain.compositeStrike),
      nearestStrike: convert(prediction.maxPain.nearestStrike),
      byExpiry: prediction.maxPain.byExpiry.map((metric) => ({ ...metric, futurePrice: calculateThaiGoldPrice(metric.futurePrice, usdThb), maxPainStrike: calculateThaiGoldPrice(metric.maxPainStrike, usdThb) })),
    },
    gamma: { ...prediction.gamma, flipStrike: convert(prediction.gamma.flipStrike) },
    scenario: { ...prediction.scenario, targetPrice: convert(prediction.scenario.targetPrice) },
    levels: prediction.levels.map((level) => ({ ...level, strike: calculateThaiGoldPrice(level.strike, usdThb) })),
  };
}

function scenarioText(label: string, language: Language) {
  if (language !== 'th') return label;
  return label === 'Upside options pressure'
    ? 'แรงหนุนจากออปชันฝั่งขึ้น'
    : label === 'Downside options pressure'
      ? 'แรงกดดันจากออปชันฝั่งลง'
      : label === 'Balanced options pressure'
        ? 'แรงจากออปชันสมดุล'
        : label;
}

function regimeText(regime: OptionsPrediction['gamma']['regime'], language: Language) {
  if (language !== 'th') return regime;
  return regime === 'positive' ? 'เป็นบวก' : regime === 'negative' ? 'เป็นลบ' : 'เป็นกลาง';
}

export default function ThaiGoldPanel({
  data,
  walls,
  wallMode,
  language,
  displayTimezone,
  showProjection,
  projectionHorizonDays,
  showForecastRange,
  dominanceOutlook,
  optionsPrediction,
  showDominanceProjection,
}: ThaiGoldPanelProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const points = data?.points ?? [];
  const latest = useMemo(() => latestPoint(data), [data]);
  const projectionBars = useMemo(() => toThaiProjectionBars(points), [points]);
  const latestUsdThb = latest?.usdThb ?? null;
  const thaiOptionsPrediction = useMemo(
    () => latestUsdThb && optionsPrediction ? convertOptionsPredictionToThai(optionsPrediction, latestUsdThb) : null,
    [latestUsdThb, optionsPrediction],
  );
  const projection = useMemo(
    () => showProjection ? buildPriceProjection(projectionBars, '1D', projectionHorizonDays, thaiOptionsPrediction) : null,
    [projectionBars, projectionHorizonDays, showProjection, thaiOptionsPrediction],
  );
  const visibleWalls = useMemo(() => walls.filter((wall) => {
    if (wallMode === 'call') return wall.callOi > 0;
    if (wallMode === 'put') return wall.putOi > 0;
    return wall.totalOi > 0;
  }), [wallMode, walls]);
  const modeTitle = t(language, 'thaiGold');
  const modeDescription = t(language, 'thaiGoldDescription');

  useEffect(() => {
    if (!chartRef.current || points.length === 0) return undefined;
    const chart = echarts.init(chartRef.current, undefined, { renderer: 'canvas' });
    const chartStart = new Date(points[0].time).getTime();
    const actualEnd = new Date(points.at(-1)!.time).getTime();
    const wallReferenceTime = Math.max(actualEnd, Date.now());
    const maxWallOi = Math.max(...visibleWalls.map((wall) => oiForWall(wall, wallMode)), 1);
    // Let Thai Gold wall overlays reach their own expiry instead of being
    // clipped at the forecast horizon.
    const maxWallEnd = Math.max(...visibleWalls.map(wallChartEnd), 0);
    const chartEnd = Math.max(actualEnd, projection?.end ?? actualEnd, maxWallEnd);
    const series = [
      {
        name: t(language, 'actualSell'),
        type: 'line' as const,
        data: points.map((point) => [new Date(point.time).getTime(), point.actualSell]),
        showSymbol: false,
        smooth: 0.22,
        lineStyle: { color: ACTUAL_SELL, width: 2.8 },
        itemStyle: { color: ACTUAL_SELL },
        z: 5,
        markLine: {
          symbol: ['none', 'none'],
          silent: true,
          lineStyle: { color: '#64748b', width: 1, type: 'dashed' as const },
          label: { color: '#cbd5e1', backgroundColor: '#1e293b', padding: [3, 5], formatter: (params: any) => params.data?.name ?? '' },
          data: [
            ...(thaiOptionsPrediction?.maxPain.compositeStrike !== null && thaiOptionsPrediction?.maxPain.compositeStrike !== undefined
              ? [{ yAxis: thaiOptionsPrediction.maxPain.compositeStrike, name: `${t(language, 'compositePain')} ${formatBaht(thaiOptionsPrediction.maxPain.compositeStrike, language)}`, lineStyle: { color: '#fb923c', width: 1.5, type: 'dashed' as const }, label: { position: 'insideStartTop' as const } }]
              : []),
            ...(thaiOptionsPrediction?.gamma.flipStrike !== null && thaiOptionsPrediction?.gamma.flipStrike !== undefined
              ? [{ yAxis: thaiOptionsPrediction.gamma.flipStrike, name: `${t(language, 'gamma')} ${t(language, 'flip')} ${formatBaht(thaiOptionsPrediction.gamma.flipStrike, language)}`, lineStyle: { color: '#38bdf8', width: 1.5, type: 'dotted' as const }, label: { position: 'insideStartTop' as const } }]
              : []),
          ],
        },
      },
      {
        name: t(language, 'actualBuy'),
        type: 'line' as const,
        data: points.map((point) => [new Date(point.time).getTime(), point.actualBuy]),
        showSymbol: false,
        smooth: 0.22,
        lineStyle: { color: ACTUAL_BUY, width: 1.7 },
        itemStyle: { color: ACTUAL_BUY },
        z: 4,
      },
      {
        name: t(language, 'calculatedThai'),
        type: 'line' as const,
        data: points.map((point) => [new Date(point.time).getTime(), point.calculatedPrice]),
        showSymbol: false,
        smooth: 0.22,
        lineStyle: { color: CALCULATED, width: 2, type: 'dashed' as const },
        itemStyle: { color: CALCULATED },
        z: 4,
      },
    ];
    const projectionSeries = projection ? {
      name: t(language, 'projectedPrice'),
      type: 'line' as const,
      yAxisIndex: 0,
      data: projection.data,
      showSymbol: false,
      smooth: 0.45,
      smoothMonotone: 'x' as const,
      lineStyle: { color: '#fb923c', width: 2, type: 'dashed' as const },
      itemStyle: { color: '#fb923c' },
      z: 5,
    } : null;
    const optionsScenarioSeries = projection?.optionsData ? {
      name: t(language, 'optionsScenario'),
      type: 'line' as const,
      yAxisIndex: 0,
      data: projection.optionsData,
      showSymbol: false,
      smooth: 0.45,
      smoothMonotone: 'x' as const,
      lineStyle: { color: '#38bdf8', width: 2, type: 'dashed' as const },
      itemStyle: { color: '#38bdf8' },
      z: 5,
    } : null;
    const forecastBandBaseline = projection && showForecastRange ? {
      name: t(language, 'forecastRange'),
      type: 'line' as const,
      yAxisIndex: 0,
      data: projection.lowerBand,
      stack: 'thai-forecast-range',
      showSymbol: false,
      silent: true,
      lineStyle: { opacity: 0 },
      areaStyle: { opacity: 0 },
      tooltip: { show: false },
      z: 1,
    } : null;
    const forecastBandSeries = projection && showForecastRange ? {
      name: `${t(language, 'forecastRange')} ${Math.round(projection.confidenceLevel * 100)}%`,
      type: 'line' as const,
      yAxisIndex: 0,
      data: projection.upperBand.map(([time, value], index) => [time, value - projection.lowerBand[index][1]]),
      stack: 'thai-forecast-range',
      showSymbol: false,
      silent: true,
      lineStyle: { opacity: 0 },
      areaStyle: { color: '#fb923c', opacity: 0.1 },
      tooltip: { show: false },
      z: 1,
    } : null;
    const dominancePoints = showDominanceProjection ? (dominanceOutlook?.points.filter((point) => {
      const baseTime = dominanceOutlook ? Date.parse(`${dominanceOutlook.baseDate}T00:00:00.000Z`) : 0;
      const pointTime = Date.parse(`${point.time}T00:00:00.000Z`);
      return pointTime <= baseTime + projectionHorizonDays * 24 * 60 * 60 * 1000;
    }) ?? []) : [];
    const dominanceSeries = dominancePoints.length ? {
      name: t(language, 'dominanceProjection'),
      type: 'line' as const,
      yAxisIndex: 1,
      data: dominancePoints
        .filter((point) => point.dominance !== null)
        .map((point) => [Date.parse(`${point.time}T00:00:00.000Z`), point.dominance as number]),
      showSymbol: false,
      smooth: 0.38,
      smoothMonotone: 'x' as const,
      lineStyle: { color: '#c084fc', width: 2, type: 'dotted' as const },
      itemStyle: { color: '#c084fc' },
      z: 3,
    } : null;
    const dominanceEnd = dominancePoints.at(-1)?.time
      ? Date.parse(`${dominancePoints.at(-1)!.time}T00:00:00.000Z`)
      : 0;
    type ThaiWallLineSeries = {
      name: string;
      type: 'line';
      yAxisIndex: number;
      data: [number, number][];
      showSymbol: boolean;
      silent: boolean;
      lineStyle: { color: string; width: number; opacity: number; type: 'solid' | 'dashed' | 'dotted' };
      z: number;
    };
    const wallSeries: ThaiWallLineSeries[] = visibleWalls.flatMap((wall) => {
      const expiryState = wallExpiryState(wall, wallReferenceTime);
      const buildSeries = (side: 'call' | 'put' | 'combined'): ThaiWallLineSeries | null => {
        const sideOi = side === 'call' ? wall.callOi : side === 'put' ? wall.putOi : wall.totalOi;
        if (sideOi <= 0) return null;
        const highOi = (wallMode === 'split' ? wall.totalOi : sideOi) >= HIGH_OI_THRESHOLD;
        const data = wallThaiData(wall, points, chartStart, chartEnd);
        if (!data) return null;
        return {
          name: t(language, 'thaiOiWalls'),
          type: 'line',
          yAxisIndex: 0,
          data,
          showSymbol: false,
          silent: true,
          lineStyle: {
            color: wallColor(wall, expiryState, side),
            width: wallWidth(sideOi, maxWallOi, highOi),
            opacity: expiryState === 'expired' ? 0.45 : expiryState === 'mixed' ? 0.58 : wall.stale ? 0.35 : side === 'combined' ? 0.78 : 0.62,
            type: expiryState === 'expired'
              ? 'dashed'
              : expiryState === 'mixed'
                ? 'dotted'
                : side === 'put' && wallMode === 'split'
                  ? 'dashed'
                  : 'solid',
          },
          z: 3,
        };
      };
      if (wallMode === 'split') return [buildSeries('call'), buildSeries('put')].filter((series): series is ThaiWallLineSeries => series !== null);
      if (wallMode === 'call') return [buildSeries('call')].filter((series): series is ThaiWallLineSeries => series !== null);
      if (wallMode === 'put') return [buildSeries('put')].filter((series): series is ThaiWallLineSeries => series !== null);
      return [buildSeries('combined')].filter((series): series is ThaiWallLineSeries => series !== null);
    });
    const wallsAtTime = (timestamp: number) => visibleWalls
      .filter((wall) => timestamp >= Date.parse(wall.from) && timestamp <= Math.min(wallChartEnd(wall), chartEnd))
      .sort((a, b) => oiForWall(b, wallMode) - oiForWall(a, wallMode))
      .slice(0, 4);
    const option: echarts.EChartsOption = {
      animation: false,
      backgroundColor: 'transparent',
      grid: { left: 76, right: 30, top: 40, bottom: 60 },
      legend: {
        top: 8,
        left: 10,
        data: [
          t(language, 'actualSell'),
          t(language, 'actualBuy'),
          t(language, 'calculatedThai'),
          ...(projectionSeries ? [t(language, 'projectedPrice')] : []),
          ...(optionsScenarioSeries ? [t(language, 'optionsScenario')] : []),
          ...(dominanceSeries ? [t(language, 'dominanceProjection')] : []),
          t(language, 'thaiOiWalls'),
        ],
        textStyle: { color: '#cbd5e1', fontSize: 11 },
        itemWidth: 24,
        itemHeight: 3,
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: { backgroundColor: '#1e293b' } },
        backgroundColor: '#0f172a',
        borderColor: '#334155',
        textStyle: { color: '#e2e8f0' },
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? params as Array<{ axisValue: number }> : [];
          const at = list[0]?.axisValue;
          if (!at) return '';
          const point = points.reduce<ThaiGoldPoint | null>((closest, candidate) => {
            if (!closest) return candidate;
            return Math.abs(new Date(candidate.time).getTime() - at) < Math.abs(new Date(closest.time).getTime() - at) ? candidate : closest;
          }, null);
          if (!point) return '';
          const isForecast = at > actualEnd;
          const lines = [`<b>${formatDate(new Date(at).toISOString(), language, displayTimezone)}</b>`];
          if (!isForecast) {
            const premium = point.premiumToSell;
            lines.push(
              `${t(language, 'actualSell')}: <b>฿${formatBaht(point.actualSell, language)}</b>`,
              `${t(language, 'actualBuy')}: <b>฿${formatBaht(point.actualBuy, language)}</b>`,
              `${t(language, 'calculatedThai')}: <b>฿${formatBaht(point.calculatedPrice, language)}</b>`,
              `<span style="color:${premium >= 0 ? PREMIUM : ACTUAL_BUY}">${t(language, 'premiumDiscount')}: <b>${premium >= 0 ? '+' : ''}฿${formatBaht(premium, language)} (${formatPct(point.premiumToSellPct, language)})</b></span>`,
              `<span style="color:#94a3b8">GC ${formatBaht(point.gcPrice, language, 2)} USD/oz · USD/THB ${formatBaht(point.usdThb, language, 2)}</span>`,
            );
          }
          const projectionIndex = projection?.data.findIndex(([time]) => time === at) ?? -1;
          const projectionPoint = projectionIndex >= 0 ? projection?.data[projectionIndex] : undefined;
          const optionsIndex = projection?.optionsData?.findIndex(([time]) => time === at) ?? -1;
          const optionsPoint = optionsIndex >= 0 ? projection?.optionsData?.[optionsIndex] : undefined;
          if (isForecast && projectionPoint) {
            const lower = projection?.lowerBand[projectionIndex]?.[1];
            const upper = projection?.upperBand[projectionIndex]?.[1];
            const leadingModel = projection?.modelScores[0];
            const modelLabel = leadingModel ? `${leadingModel.name} ${Math.round(leadingModel.weight * 100)}%` : 'ensemble';
            lines.push(`<span style="color:#fb923c">${t(language, 'forecastValue')}: <b>฿${formatBaht(projectionPoint[1], language)}</b> · ${projection?.regime ?? 'range'}</span>`);
            lines.push(`<span style="color:#fdba74">${t(language, 'ensembleModel')} · ${modelLabel} · MAE ฿${formatBaht(projection?.backtestMae ?? null, language)}</span>`);
            if (showForecastRange && lower !== undefined && upper !== undefined) lines.push(`<span style="color:#fdba74">${t(language, 'forecastRange')}: ฿${formatBaht(lower, language)}–฿${formatBaht(upper, language)}</span>`);
          }
          if (isForecast && optionsPoint && thaiOptionsPrediction) {
            lines.push(`<span style="color:#38bdf8">${t(language, 'optionsGuide')}: <b>฿${formatBaht(optionsPoint[1], language)}</b> · ${t(language, 'targetGuide')} ${formatBaht(thaiOptionsPrediction.scenario.targetPrice, language)}</span>`);
            lines.push(`<span style="color:#7dd3fc">${scenarioText(thaiOptionsPrediction.scenario.label, language)} · ${t(language, 'nearestPain')} ${formatBaht(thaiOptionsPrediction.maxPain.nearestStrike, language)} · Gamma ${regimeText(thaiOptionsPrediction.gamma.regime, language)}</span>`);
          }
          const dominancePoint = dominanceOutlook?.points.find((item) => item.time === new Date(at).toISOString().slice(0, 10));
          if (isForecast && dominancePoint?.dominance !== null && dominancePoint?.dominance !== undefined) {
            lines.push(`<span style="color:#c084fc">${t(language, 'dominanceForecast')}: <b>${(dominancePoint.dominance * 100).toFixed(0)}%</b> · ${dominancePoint.activeExpiryCount} expiry</span>`);
          }
          const activeWalls = wallsAtTime(at);
          if (activeWalls.length > 0) {
            lines.push(`<br/><span style="color:#94a3b8">${t(language, 'thaiOiWalls')}</span>`);
            for (const wall of activeWalls) {
              const expiryState = wallExpiryState(wall, wallReferenceTime);
              const side = wallMode === 'call' ? 'call' : wallMode === 'put' ? 'put' : 'combined';
              const rate = usdThbAt(points, at) ?? point.usdThb;
              const thaiStrike = calculateThaiGoldPrice(wall.strike, rate);
              const oiLabel = wallMode === 'call'
                ? `C ${wall.callOi.toLocaleString()}`
                : wallMode === 'put'
                  ? `P ${wall.putOi.toLocaleString()}`
                  : wallMode === 'split'
                    ? `C ${wall.callOi.toLocaleString()} / P ${wall.putOi.toLocaleString()}`
                    : `OI ${wall.totalOi.toLocaleString()}`;
              lines.push(`<span style="color:${wallColor(wall, expiryState, side)}">฿${thaiStrike.toLocaleString()} · GC $${wall.strike.toLocaleString()} · ${oiLabel} · D ${(wall.dominance * 100).toFixed(0)}% · ${expiryState}</span>`);
            }
          }
          return lines.join('<br/>');
        },
      },
      xAxis: {
        type: 'time',
        axisLabel: { color: '#94a3b8', hideOverlap: true },
        axisLine: { lineStyle: { color: '#334155' } },
        splitLine: { show: false },
        min: chartStart,
        max: Math.max(chartEnd, dominanceEnd),
      },
      yAxis: [
        {
          type: 'value',
          scale: true,
          name: t(language, 'bahtPerWeight'),
          nameTextStyle: { color: '#94a3b8' },
          axisLabel: { color: '#94a3b8', formatter: (value: number) => `฿${formatBaht(value, language)}` },
          axisLine: { lineStyle: { color: '#475569' } },
          splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.35)' } },
        },
        {
          type: 'value',
          min: -1,
          max: 1,
          name: t(language, 'dominanceOutlook'),
          nameTextStyle: { color: '#94a3b8' },
          axisLabel: { color: '#94a3b8', formatter: (value: number) => `${value > 0 ? '+' : ''}${Math.round(value * 100)}%` },
          axisLine: { lineStyle: { color: '#64748b' } },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
        { type: 'slider', xAxisIndex: 0, height: 22, bottom: 12, borderColor: '#334155', backgroundColor: '#111827', fillerColor: 'rgba(94, 234, 212, 0.16)', handleStyle: { color: '#5eead4' }, textStyle: { color: '#94a3b8' } },
      ],
      series: [
        ...(forecastBandBaseline ? [forecastBandBaseline] : []),
        ...(forecastBandSeries ? [forecastBandSeries] : []),
        ...series,
        ...(projectionSeries ? [projectionSeries] : []),
        ...(optionsScenarioSeries ? [optionsScenarioSeries] : []),
        ...(dominanceSeries ? [dominanceSeries] : []),
        ...wallSeries,
      ],
    };
    chart.setOption(option);
    const resize = () => chart.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chart.dispose();
    };
  }, [displayTimezone, dominanceOutlook, language, optionsPrediction, points, projection, projectionHorizonDays, showDominanceProjection, showForecastRange, thaiOptionsPrediction, visibleWalls, wallMode]);

  if (!data || !latest) {
    return <section className="thai-panel empty-state"><strong>{t(language, 'noThaiData')}</strong><span>{t(language, 'loading')}</span></section>;
  }

  const premiumPositive = latest.premiumToSell >= 0;
  return (
    <section className="thai-panel" aria-label={modeTitle}>
      <div className="thai-panel-header">
        <div>
          <span className="control-label">{t(language, 'thaiBar')}</span>
          <h2>{modeTitle}</h2>
          <p>{modeDescription}</p>
        </div>
        <div className="thai-source-meta">
          <span>{t(language, 'source')}: {t(language, 'sourceOfficialShort')}</span>
          <span>{t(language, 'asOf')} {formatDate(latest.asOf, language, displayTimezone)}</span>
          <span className={data.freshness === 'fresh' ? 'source-fresh' : 'source-stale'}>{data.freshness === 'fresh' ? t(language, 'fresh') : t(language, 'stale')}</span>
        </div>
      </div>

      <div className="thai-metric-grid">
        <div className="thai-metric-card actual-sell-card"><span>{t(language, 'actualSell')}</span><strong>฿{formatBaht(latest.actualSell, language)}</strong><small>{t(language, 'thaiBar')}</small></div>
        <div className="thai-metric-card actual-buy-card"><span>{t(language, 'actualBuy')}</span><strong>฿{formatBaht(latest.actualBuy, language)}</strong><small>{t(language, 'thaiBar')}</small></div>
        <div className="thai-metric-card calculated-card"><span>{t(language, 'calculatedThai')}</span><strong>฿{formatBaht(latest.calculatedPrice, language)}</strong><small>GC {formatBaht(latest.gcPrice, language, 2)} · USD/THB {formatBaht(latest.usdThb, language, 2)}</small></div>
        <div className={`thai-metric-card premium-card ${premiumPositive ? 'premium-positive' : 'premium-negative'}`}><span>{t(language, 'premiumDiscount')}</span><strong>{premiumPositive ? '+' : ''}฿{formatBaht(latest.premiumToSell, language)}</strong><small>{formatPct(latest.premiumToSellPct, language)} vs sell-out</small></div>
      </div>

      <div className="thai-chart-card">
        <div className="thai-chart-heading">
          <strong>{t(language, 'thaiOiWalls')}</strong>
          <span>{visibleWalls.length.toLocaleString()} {t(language, 'wallCount')} · {t(language, 'thaiOiWallsHelp')}</span>
        </div>
        <div ref={chartRef} className="thai-chart-canvas" />
      </div>

    </section>
  );
}

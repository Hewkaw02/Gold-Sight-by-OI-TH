import type { PriceBar, ThaiGoldData, ThaiGoldPoint } from '../src/domain/types.js';
import { buildThaiGoldPoint, localDateKey, THAI_GOLD_CONVERSION_FACTOR, THAI_GOLD_BAR_WEIGHT_GRAMS, THAI_GOLD_PURITY, TROY_OUNCE_GRAMS, THAI_GOLD_FORMULA, priceBarDate } from '../src/domain/thai-gold.js';

const SOURCE = 'goldtraders.or.th';
const LATEST_URL = 'https://www.goldtraders.or.th/api/GoldPrices/Latest?readjson=false';
const HISTORY_URL = 'https://www.goldtraders.or.th/api/GoldPricesDaily/pricechanges';

export interface GoldTradersPriceRow {
  asTime: string;
  bL_BuyPrice: number;
  bL_SellPrice: number;
  bahtPerUSD: number;
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'Gold-Sight-by-OI/1.0' },
  });
  if (!response.ok) throw new Error(`Thai gold request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function formatBangkokDate(value: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(value);
}

function normalizeAsOf(value: string) {
  return value.endsWith('Z') || value.includes('+') ? value : `${value}+07:00`;
}

function isValidRow(row: Partial<GoldTradersPriceRow>): row is GoldTradersPriceRow {
  return typeof row.asTime === 'string'
    && Number.isFinite(row.bL_BuyPrice)
    && Number.isFinite(row.bL_SellPrice)
    && typeof row.bahtPerUSD === 'number'
    && Number.isFinite(row.bahtPerUSD)
    && row.bahtPerUSD > 0;
}

function latestByBangkokDate(rows: GoldTradersPriceRow[]) {
  const byDate = new Map<string, GoldTradersPriceRow>();
  for (const row of rows.filter(isValidRow)) {
    const date = row.asTime.slice(0, 10);
    const current = byDate.get(date);
    if (!current || row.asTime > current.asTime) byDate.set(date, row);
  }
  return byDate;
}

function nearestPriceBar(priceByDate: Map<string, PriceBar>, sortedDates: string[], date: string) {
  const exact = priceByDate.get(date);
  if (exact) return exact;
  let nearest: PriceBar | undefined;
  for (const candidateDate of sortedDates) {
    if (candidateDate > date) break;
    nearest = priceByDate.get(candidateDate) ?? nearest;
  }
  return nearest;
}

export function buildThaiGoldPoints(rows: GoldTradersPriceRow[], priceBars: PriceBar[]) {
  const rowsByDate = latestByBangkokDate(rows);
  const priceByDate = new Map<string, PriceBar>();
  for (const bar of priceBars.filter((value) => value.isClosed && Number.isFinite(value.close))) {
    priceByDate.set(priceBarDate(bar), bar);
  }
  const priceDates = [...priceByDate.keys()].sort();
  const points: ThaiGoldPoint[] = [];
  for (const [date, row] of [...rowsByDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const priceBar = nearestPriceBar(priceByDate, priceDates, date);
    if (!priceBar) continue;
    points.push(buildThaiGoldPoint(
      normalizeAsOf(row.asTime),
      row.bL_BuyPrice,
      row.bL_SellPrice,
      priceBar.close,
      row.bahtPerUSD,
      SOURCE,
    ));
  }
  return points;
}

export function mergeThaiGoldData(existing: ThaiGoldData | null, incoming: ThaiGoldData) {
  const byDate = new Map<string, ThaiGoldPoint>();
  for (const point of existing?.points ?? []) byDate.set(localDateKey(point.time), point);
  for (const point of incoming.points) byDate.set(localDateKey(point.time), point);
  const points = [...byDate.values()].sort((a, b) => a.time.localeCompare(b.time)).slice(-500);
  return {
    ...incoming,
    points,
    coverage: { start: points[0]?.time.slice(0, 10) ?? null, end: points.at(-1)?.time.slice(0, 10) ?? null },
  } satisfies ThaiGoldData;
}

export async function fetchThaiGoldData(priceBars: PriceBar[], historyDays = 180): Promise<ThaiGoldData> {
  const now = new Date();
  const start = new Date(now.getTime() - Math.max(7, historyDays) * 24 * 60 * 60 * 1000);
  const startDate = formatBangkokDate(start);
  const endDate = formatBangkokDate(now);
  const historyUrl = `${HISTORY_URL}?StartDate=${encodeURIComponent(startDate)}&EndDate=${encodeURIComponent(endDate)}`;
  const [latest, history] = await Promise.all([
    readJson<GoldTradersPriceRow>(LATEST_URL),
    readJson<GoldTradersPriceRow[]>(historyUrl),
  ]);
  const rows = [...(Array.isArray(history) ? history : []), latest].filter(isValidRow);
  const points = buildThaiGoldPoints(rows, priceBars);
  if (points.length === 0) throw new Error('Thai gold source returned no rows aligned with closed GC daily bars');
  const latestPoint = points.at(-1)!;
  const ageHours = (Date.now() - Date.parse(latestPoint.asOf)) / 3_600_000;
  return {
    schemaVersion: 1,
    symbol: 'THAI_GOLD',
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    unit: 'THB_PER_BAHT_WEIGHT',
    goldType: '96.5%_GOLD_BAR',
    conversion: {
      barWeightGrams: THAI_GOLD_BAR_WEIGHT_GRAMS,
      purity: THAI_GOLD_PURITY,
      troyOunceGrams: TROY_OUNCE_GRAMS,
      factor: THAI_GOLD_CONVERSION_FACTOR,
      formula: THAI_GOLD_FORMULA,
    },
    coverage: { start: points[0]?.time.slice(0, 10) ?? null, end: points.at(-1)?.time.slice(0, 10) ?? null },
    freshness: Number.isFinite(ageHours) && ageHours <= 72 ? 'fresh' : 'stale',
    points,
  };
}

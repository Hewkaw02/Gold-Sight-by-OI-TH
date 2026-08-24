import type { PriceBar, ThaiGoldData, ThaiGoldPoint } from '../src/domain/types.js';
import { buildThaiGoldPoint, localDateKey, THAI_GOLD_CONVERSION_FACTOR, THAI_GOLD_BAR_WEIGHT_GRAMS, THAI_GOLD_PURITY, TROY_OUNCE_GRAMS, THAI_GOLD_FORMULA, priceBarDate } from '../src/domain/thai-gold.js';

const SOURCE = 'goldtraders.or.th';
// The association has more than one official API host. GitHub-hosted runners
// can be rejected by the canonical www host even while the association's
// alternate host is serving the same current data.
const API_BASE_URLS = [
  'https://www.goldtraders.or.th/api',
  'https://goldtraders.or.th/api',
  'https://newgta.goldtraders.or.th/api',
];
const CLASSIC_HISTORY_URL = 'https://classic.goldtraders.or.th/UpdatePriceList.aspx';
const LATEST_PATH = '/GoldPrices/Latest?readjson=false';
const HISTORY_PATH = '/GoldPricesDaily/pricechanges';

export interface GoldTradersPriceRow {
  asTime: string;
  bL_BuyPrice: number;
  bL_SellPrice: number;
  bahtPerUSD: number;
}

async function readOfficialApiJson<T>(path: string): Promise<T> {
  const errors: string[] = [];
  for (const baseUrl of API_BASE_URLS) {
    const url = `${baseUrl}${path}`;
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json, text/plain, */*',
          referer: 'https://www.goldtraders.or.th/',
          'user-agent': 'Mozilla/5.0 (compatible; Gold-Sight-by-OI/1.0)',
        },
      });
      if (!response.ok) {
        errors.push(`${new URL(baseUrl).hostname}: HTTP ${response.status}`);
        continue;
      }
      return response.json() as Promise<T>;
    } catch (error) {
      errors.push(`${new URL(baseUrl).hostname}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Thai gold API request failed across official endpoints (${errors.join(' | ')})`);
}

function htmlText(value: string) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function classicAsTime(value: string) {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, day, month, buddhistYear, hour, minute] = match;
  return `${Number(buddhistYear) - 543}-${month}-${day}T${hour}:${minute}:00`;
}

function numericCell(value: string) {
  const number = Number(value.replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

export function parseClassicUpdatePriceRows(html: string): GoldTradersPriceRow[] {
  const rows: GoldTradersPriceRow[] = [];
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => htmlText(match[1]));
    if (cells.length < 8) continue;
    const asTime = classicAsTime(cells[0]);
    const bLBuyPrice = numericCell(cells[2]);
    const bLSellPrice = numericCell(cells[3]);
    const bahtPerUSD = numericCell(cells[7]);
    if (!asTime || bLBuyPrice === null || bLSellPrice === null || bahtPerUSD === null || bahtPerUSD <= 0) continue;
    rows.push({ asTime, bL_BuyPrice: bLBuyPrice, bL_SellPrice: bLSellPrice, bahtPerUSD });
  }
  return rows;
}

async function readClassicUpdatePriceRows(): Promise<GoldTradersPriceRow[]> {
  const response = await fetch(CLASSIC_HISTORY_URL, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      referer: 'https://www.goldtraders.or.th/',
      'user-agent': 'Mozilla/5.0 (compatible; Gold-Sight-by-OI/1.0)',
    },
  });
  if (!response.ok) throw new Error(`Classic Thai gold page failed (${response.status})`);
  const rows = parseClassicUpdatePriceRows(await response.text());
  if (rows.length === 0) throw new Error('Classic Thai gold page returned no price rows');
  return rows;
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
  const historyPath = `${HISTORY_PATH}?StartDate=${encodeURIComponent(startDate)}&EndDate=${encodeURIComponent(endDate)}`;
  let latest: GoldTradersPriceRow;
  let history: GoldTradersPriceRow[];
  try {
    [latest, history] = await Promise.all([
      readOfficialApiJson<GoldTradersPriceRow>(LATEST_PATH),
      readOfficialApiJson<GoldTradersPriceRow[]>(historyPath),
    ]);
    // The API can respond successfully with an older cached snapshot. Overlay
    // the current official page when it is reachable so a newer intraday row
    // always wins during the date-level merge below.
    try {
      history = [...history, ...(await readClassicUpdatePriceRows())];
    } catch {
      // Keep the API result when the optional freshness overlay is unavailable.
    }
  } catch (apiError) {
    try {
      history = await readClassicUpdatePriceRows();
      latest = history[0];
    } catch (classicError) {
      throw new Error(`${apiError instanceof Error ? apiError.message : String(apiError)}; ${classicError instanceof Error ? classicError.message : String(classicError)}`);
    }
  }
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

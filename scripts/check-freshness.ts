import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DataManifest, PriceBar, PriceTimeframe, ThaiGoldData } from '../src/domain/types.js';
import { priceFreshness } from '../collector/shared/data-freshness.js';

const dataRoot = path.resolve(process.env.GOLD_SIGHT_DATA_ROOT ?? 'public/data');
const symbol = process.env.GOLD_SIGHT_SYMBOL ?? 'GC';
const now = Date.parse(process.env.FRESHNESS_NOW ?? new Date().toISOString());
const configuredThaiGoldMaxAgeHours = Number(process.env.THAI_GOLD_MAX_AGE_HOURS ?? 72);
const thaiGoldMaxAgeHours = Number.isFinite(configuredThaiGoldMaxAgeHours) && configuredThaiGoldMaxAgeHours > 0
  ? configuredThaiGoldMaxAgeHours
  : 72;

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function readPrice(timeframe: PriceTimeframe) {
  const relative = timeframe === '1D' ? '1d' : '4h';
  return JSON.parse(await readFile(path.join(dataRoot, 'price', symbol, relative, 'latest.json'), 'utf8')) as PriceBar[];
}

const results = await Promise.all((['1D', '4H'] as const).map(async (timeframe) => {
  const result = priceFreshness(await readPrice(timeframe), timeframe, now);
  return {
    timeframe,
    closeTime: result.closeTime,
    ageHours: Number.isFinite(result.ageHours) ? Number(result.ageHours.toFixed(2)) : null,
    maxAgeHours: result.maxAgeHours,
    fresh: result.fresh,
  };
}));

const thaiGold = await readOptionalJson<ThaiGoldData>(path.join(dataRoot, 'thai-gold', 'latest.json'));
const manifest = await readOptionalJson<DataManifest>(path.join(dataRoot, 'manifest.json'));
const latestThaiGold = thaiGold?.points.at(-1);
const thaiGoldAsOf = latestThaiGold?.asOf ?? null;
const thaiGoldAsOfTime = thaiGoldAsOf ? Date.parse(thaiGoldAsOf) : Number.NaN;
const thaiGoldAgeHours = Number.isFinite(thaiGoldAsOfTime)
  ? Math.max(0, (now - thaiGoldAsOfTime) / (60 * 60 * 1000))
  : Number.POSITIVE_INFINITY;
const thaiGoldCollectorError = manifest?.health.notes.find((note) => note.startsWith('Thai gold collector:')) ?? null;
const thaiGoldResult = {
  latestAsOf: thaiGoldAsOf,
  coverageEnd: thaiGold?.coverage.end ?? null,
  ageHours: Number.isFinite(thaiGoldAgeHours) ? Number(thaiGoldAgeHours.toFixed(2)) : null,
  maxAgeHours: thaiGoldMaxAgeHours,
  state: manifest?.health.thaiGold?.state ?? null,
  sourceError: thaiGoldCollectorError,
  fresh: Boolean(latestThaiGold)
    && thaiGold?.freshness === 'fresh'
    && manifest?.health.thaiGold?.state !== 'stale'
    && manifest?.health.thaiGold?.state !== 'error'
    && thaiGoldAgeHours <= thaiGoldMaxAgeHours
    && !thaiGoldCollectorError,
};

console.log(JSON.stringify({ checkedAt: new Date(now).toISOString(), results, thaiGold: thaiGoldResult }, null, 2));
if (results.some((result) => !result.fresh)) {
  console.error('Price freshness check failed: at least one timeframe is beyond its allowed age.');
  process.exitCode = 1;
}
if (!thaiGoldResult.fresh) {
  console.error('Thai Gold freshness check failed: the latest official Thai Gold dataset is missing, stale, or failed to refresh.');
  process.exitCode = 1;
}

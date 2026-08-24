import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ensureCmeAuthenticated, openCmeBrowser } from '../collector/cme/cme-browser.js';
import { fetchExpirySeries } from '../collector/cme/cme-options-fetcher.js';
import { readJson, sha256Json, writeJsonAtomic } from '../collector/shared/json-store.js';
import type { ContractExpirySeries, DataManifest } from '../src/domain/types.js';

const symbol = process.env.GOLD_SIGHT_SYMBOL ?? 'GC';
const dataRoot = path.resolve(process.env.GOLD_SIGHT_DATA_ROOT ?? 'public/data');
const seriesPath = path.join(dataRoot, 'oi', symbol, 'expiry-series-latest.json');
const manifestPath = path.join(dataRoot, 'manifest.json');

async function patchManifest(series: ContractExpirySeries): Promise<void> {
  const manifest = await readJson<DataManifest | null>(manifestPath, null);
  if (!manifest) return;

  const generatedAt = new Date().toISOString();
  await writeJsonAtomic(manifestPath, {
    ...manifest,
    generatedAt,
    coverage: {
      ...manifest.coverage,
      contractExpiry: series.coverage,
    },
    datasets: {
      ...manifest.datasets,
      contract_expiry_series: {
        path: `oi/${symbol}/expiry-series-latest.json`,
        schemaVersion: series.schemaVersion,
        generatedAt: series.generatedAt,
        coverageStart: series.coverage.start,
        coverageEnd: series.coverage.end,
        rowCount: series.expiries.length,
        sha256: sha256Json(series),
        freshness: 'fresh',
      },
    },
  });
}

async function main(): Promise<void> {
  await mkdir(path.dirname(seriesPath), { recursive: true });
  const previous = await readJson<ContractExpirySeries | null>(seriesPath, null);
  const session = await openCmeBrowser();

  try {
    await ensureCmeAuthenticated(session);
    const raw = await fetchExpirySeries(session.page);
    const expiries = raw.map(({ code, label, groupLabel, date }) => ({
      code,
      label,
      groupLabel,
      expiryDate: date,
    }));
    if (expiries.length === 0) throw new Error('CME returned no contract expiry series');

    const dates = expiries.map((item) => item.expiryDate).sort();
    const series: ContractExpirySeries = {
      schemaVersion: 1,
      symbol,
      generatedAt: new Date().toISOString(),
      source: 'cme_options_expirations',
      coverage: { start: dates[0] ?? null, end: dates.at(-1) ?? null },
      expiries,
    };
    await writeJsonAtomic(seriesPath, series);
    await patchManifest(series);
    console.log(JSON.stringify({
      state: 'ok',
      expirySeries: series.expiries.length,
      coverage: series.coverage,
      generatedAt: series.generatedAt,
      replacedPrevious: previous?.generatedAt ?? null,
    }, null, 2));
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

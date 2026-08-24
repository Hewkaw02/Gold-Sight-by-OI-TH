# Gold Sight by OI

Static GC futures price line chart with a time-price Options Open Interest wall overlay.

The dashboard is intentionally static so it can be hosted on GitHub Pages. The collector is standalone: the required CME login, Vol2Vol, options-chain, and parser functions live in this repository under `collector/cme/`. It does not call or modify another project at runtime.

## What is implemented

- `BLACKBULL:GOLD.F` price history at `4H` and `1D`; `latest.json` may include the current open candle, while the chart and model use closed bars only.
- Partitioned JSON with `latest.json` indexes and atomic writes.
- GC Vol2Vol tenor snapshots for target DTE `7/15/30/60/90`, with `close → mid → open` selection. When a far tenor is not present in Vol2Vol, verified all-expiry chain snapshots fill only the additional `60D/90D` front-equivalent buckets.
- Separate `All expiries` OI layer built from the standalone CME options-chain function, preserving far-dated contracts/LEAPS alongside the default front-equivalent view.
- Deduplication by unique `expiry_date + strike`, so multiple tenor labels do not double-count OI.
- OI enrichment from the standalone CME options function when the Vol2Vol tenor page supplies volume/IV but no OI.
- Dynamic P90 significance threshold per snapshot.
- Wall modes: `Combined`, `Call only`, `Put only`, and `Split`.
- Noise filters for minimum wall strength and Call/Put/Balanced dominance; `Front equivalent` also exposes selectable `7D`, `15D`, `30D`, `60D`, and `90D` coverage chips. The DTE chips filter provenance coverage while keeping each displayed OI value as the front composite, so the UI does not imply a single-tenor recalculation.
- Visible Minimum OI slicer filters walls from `1,000` through `10,000` OI in `500`-contract steps, using the active Call/Put/Total Wall mode and updating the wall count live.
- Dominance score from `-1` Put to `+1` Call; raw Call/Put/Total OI remains in tooltip/data.
- Wall colors distinguish unexpired walls (Call/Put dominance colors), expired walls (muted slate dashed lines), and composite walls containing both states (amber dotted lines); the tooltip and Series details view label the state explicitly.
- Expiry visibility filters hide fully expired and mixed-expiry walls by default without deleting the source JSON; each state can be shown independently from the dashboard.
- Wall width emphasizes OI at or above `10,000` in the active Wall mode; near-balanced Call/Put walls (dominance within ±15%) use a neutral white color instead of Call/Put dominance colors.
- Wall lines extend through the latest expiry date represented by the composite wall, so future support/resistance horizons remain visible instead of stopping at the last observed snapshot.
- `Chart / Series details` view shows the expiry-series inventory, expiry status, DTE coverage, wall counts, strike levels, OI, dominance, chart period, and wall lifecycle using the same active filters as the chart.
- Dashboard defaults to a June-to-date chart window and can show a selected `30D/60D/90D` forecast horizon; the forecast is explicitly labeled as a guide, not actual market data.
- The price forecast uses a rolling-origin weighted ensemble of naive, median-drift, EMA-reversion, and damped-trend candidates. Model weights come from walk-forward MAE/MAPE, with EMA, robust volatility, trend R², and a trend/range/volatile regime summary exposed in the chart tooltip.
- The options-aware prediction pipeline processes the full active expiry surface into `prediction/GC/latest.json`: composite and nearest-expiry Max Pain, Black-76 Delta/Gamma/Vanna exposure, Gamma flip, IV coverage, fallback-volatility warnings, and a bounded options scenario guide layered on the historical ensemble forecast. The signed OI convention is explicitly heuristic because OI alone does not reveal dealer positioning.
- The forecast includes an optional estimated 80% range derived from backtest error plus robust volatility (off by default so uncertainty does not distort the price scale), while the expiry-aware dominance outlook uses the same selected horizon and carries forward the latest verified EOD OI while removing contracts as they expire.
- Wall segment lifecycle with expiry/roll termination, two-trading-session stale grace, and provenance.
- Auth/data health banner for `LIVE`, `PARTIAL`, `STALE`, `ERROR`, and CME login challenge.
- Two dashboard modes: `Future` keeps the original GC/OI-wall view, while `Thai Gold` shows the official Thai 96.5% gold-bar quote with the same wall mode, expiry scope, OI, strength, dominance, expired/mixed, and DTE filters.
- The dashboard opens in `Thai Gold` by default. Its Predict system uses Thai sell-out history for the rolling-origin ensemble, converts Options-aware Max Pain/Gamma/target levels into baht-weight, and supports projection, 30/60/90D horizon, uncertainty range, and expiry-decay dominance controls; `Future` retains the original GC-denominated predictor.
- Thai Gold conversion is transparent and intentionally uncalibrated: `GC USD/oz × USD/THB × (15.244 × 0.965 ÷ 31.1034768)`, rounded to the nearest `฿50`. The actual-versus-calculated gap is shown as Thai-market `Premium / Discount`, not hidden inside the formula.
- Thai Gold data is collected from the [Gold Traders Association](https://www.goldtraders.or.th/) public API. The collector stores actual buy/sell prices, the aligned GC close, the source USD/THB rate, formula metadata, freshness, and coverage in `public/data/thai-gold/latest.json`.
- A Thai/English toggle is available in the dashboard and persists in browser local storage; Thai is the default.
- GitHub Actions collection, CI, GHCR image publishing, and Pages deployment.

## Local development

```powershell
npm install
npm run dev
```

The checked-in `public/data` contains a safe demo/normalized seed so the UI works without credentials.

Build and verify:

npm run typecheck
npm test
npm run build

## Docker

The easiest Windows commands are:

```powershell
.\scripts\docker.ps1 dashboard  # build + run Dashboard + scheduler
.\scripts\docker.ps1 scheduler  # start only the scheduler container
.\scripts\docker.ps1 refresh    # refresh price and rebuild derived JSON
.\scripts\docker.ps1 live-oi    # collect CME OI; requires .env credentials/session
.\scripts\docker.ps1 status
.\scripts\docker.ps1 down
```

Open `http://localhost:8080`. If that port is already in use, set `$env:DASHBOARD_PORT = '8085'` before running the helper. The dashboard container mounts `public/data` read-only, so refreshed JSON appears immediately without rebuilding the dashboard image. The default `dashboard` helper also starts the separate scheduler container.

The manual `refresh` and `live-oi` helpers temporarily stop an already-running scheduler before the one-shot collector starts, then start it again, so both processes do not write the same dataset concurrently.

Equivalent raw Docker Compose commands:

```powershell
docker compose up -d --build dashboard scheduler
```

The container serves `/healthz` for health checks and disables caching for normalized JSON. The collector image includes Python/tvdatafeed and Camoufox:

```powershell
docker compose --profile collector build collector
docker compose --profile collector run --rm -e RUN_LIVE_OI=false collector
```

For live OI, create a local `.env` from `.env.example`, add `CME_EMAIL` and `CME_PASSWORD`, then run:

```powershell
docker compose --profile collector run --rm -e RUN_LIVE_OI=true collector
```

`public/data` and `runtime` are bind-mounted as shown in `compose.yaml`; keep CME credentials and the saved browser session outside the image. The `collector` service remains a one-shot job for manual runs. The separate `scheduler` service stays online, refreshes the CME contract/expiry inventory at startup and daily at `06:30`, runs price + Thai Gold every 15 minutes on weekdays, and runs CME OI at `07:50`, `09:55`, and `12:20` in `America/Chicago`. It serializes runs so a slow collection cannot start a duplicate process, and continues scheduling after a failed run.

### Local Docker scheduler

Start the dashboard and scheduler together:

```powershell
docker compose up -d --build dashboard scheduler
docker compose ps
docker compose logs -f scheduler
```

Scheduler defaults can be changed in `.env`: `SCHEDULER_PRICE_INTERVAL_MINUTES`, `SCHEDULER_PRICE_TIMEZONE`, `SCHEDULER_OI_TIMES`, `SCHEDULER_OI_SLOTS`, `SCHEDULER_OI_GRACE_MINUTES`, `SCHEDULER_EXPIRY_SERIES_TIMEZONE`, `SCHEDULER_EXPIRY_SERIES_TIME`, and `SCHEDULER_EXPIRY_SERIES_GRACE_MINUTES`. `SCHEDULER_RUN_ON_START=true` performs one price + Thai Gold refresh, while `SCHEDULER_EXPIRY_SERIES_RUN_ON_START=true` refreshes the contract/expiry inventory when the scheduler container starts.

## Local seed / rebuild

The seed command rebuilds derived walls and manifests from the normalized JSON already inside this repository. It does not read another project or copy external files.

```powershell
$env:GOLD_SIGHT_DATA_ROOT = 'public/data'
npm run collector:seed
```

The seed command also refreshes the Thai Gold dataset by default. Set `RUN_LIVE_THAI_GOLD=false` for an offline rebuild. `sourceFile`, `rawSha256`, `oiAsOfDate`, and `oiSource` are retained so the dashboard data can be audited. `oiSource` is one of `vol2vol`, `options_chain_eod`, `mixed`, or `missing`.

## Credentials and automated CME login

Do not commit `.env`, cookie files, or credentials. TradingView credentials are not required by the current price adapter: it calls `TvDatafeed()` anonymously unless both optional `TV_USERNAME` and `TV_PASSWORD` variables are supplied for a symbol that TradingView limits.

The self-hosted runner reads:

- `CME_EMAIL` / `CME_PASSWORD` — used only when the saved CME session has expired and a fresh login is needed.
- optional `CME_STORAGE_STATE_PATH` — the saved Camoufox/CME browser session file; it avoids logging in every run and is sensitive session data. The default is `runtime/cme-storage-state.json`.

`npm run auth:cme` first reuses the cookie file and only opens Camoufox login when the Vol2Vol access check fails. If CME presents MFA/CAPTCHA, it writes `auth.state = challenge` to the public status JSON and stops without replacing good OI data. It does not attempt to bypass the challenge.

Camoufox is installed as a dependency of this repository; no external GetDataCMEBoy installation is required.

## GitHub Actions / Pages

1. Create a public repository named `gold-sight-by-oi`.
2. Add repository secrets `CME_EMAIL` and `CME_PASSWORD`.
3. Set Pages source to **GitHub Actions**.
4. Enable the `github-pages` environment.

`price-refresh.yml` runs the anonymous TradingView price refresh every 15 minutes on weekdays, uses the candle close time to keep the newest completed 1D/4H bar, verifies freshness, and commits only normalized/public JSON. `collect.yml` runs the CME collector on a GitHub-hosted Ubuntu runner at the configured GC open/mid/close schedule in `America/Chicago` (`07:50`, `09:55`, `12:20` weekdays). `expiry-refresh.yml` refreshes the CME contract/expiry inventory daily at `06:30` in `America/Chicago`. Both CME workflows use a fresh headless browser session per run and require the `CME_EMAIL`/`CME_PASSWORD` repository secrets; an MFA/CAPTCHA challenge stops the run without replacing good data. All data workflows share a concurrency group so commits do not race.

GitHub Actions jobs are one-shot runners, so they can replace the Docker scheduler with these scheduled workflows, but they cannot keep `npm run scheduler` or a Docker container alive continuously on a GitHub-hosted runner. `docker-publish.yml` publishes both the dashboard image and the collector/scheduler image to GHCR on `main`/version tags. Set `DASHBOARD_IMAGE` and `COLLECTOR_IMAGE` in `.env` when running those published images with Compose.

GitHub scheduled workflows can be delayed under load, so the freshness check fails when price data exceeds the configured grace period instead of silently publishing an old dataset. A daily bar can legitimately remain one session behind until its exchange candle close; the adapter now checks `closeTime <= now` rather than discarding the final returned row unconditionally.

## Data layout

```text
public/data/
  price/GC/4h/YYYY/MM/YYYY-MM-DD.json
  price/GC/4h/latest.json
  price/GC/1d/YYYY/MM/YYYY-MM-DD.json
  price/GC/1d/latest.json
  oi/GC/YYYY-MM-DD/{slot}-{targetDte}dte.json
  oi/GC/latest.json
  oi/GC/all-expiry/YYYY-MM-DD.json
  oi/GC/all-expiries-latest.json
  oi/GC/dominance-outlook.json
  oi/GC/expiry-series-latest.json
  prediction/GC/latest.json
  walls/GC/latest.json
  walls/GC/all-expiries-latest.json
  rolls/GC/latest.json
  thai-gold/latest.json
  status/latest.json
  manifest.json
```

Raw browser/CME payloads stay on the self-hosted runner. The public site receives only normalized/derived records required for the chart and audit metadata.

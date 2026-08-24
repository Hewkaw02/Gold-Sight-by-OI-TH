import { spawn, type ChildProcess } from 'node:child_process';

type CollectorRun = 'price' | 'oi' | 'expiry-series';
type OiSlot = 'open' | 'mid' | 'close';

interface ZonedClock {
  dateKey: string;
  hour: number;
  minute: number;
  weekday: number;
}

interface ScheduledRun {
  id: string;
  kind: CollectorRun;
  slot?: OiSlot;
}

interface SchedulerConfig {
  runOnStart: boolean;
  runExpirySeriesOnStart: boolean;
  pollSeconds: number;
  priceIntervalMinutes: number;
  priceTimeZone: string;
  oiTimeZone: string;
  oiTimes: Array<{ label: string; hour: number; minute: number }>;
  oiSlots: OiSlot[];
  oiGraceMinutes: number;
  expirySeriesTimeZone: string;
  expirySeriesTime: { label: string; hour: number; minute: number };
  expirySeriesGraceMinutes: number;
  dryRun: boolean;
}

const DEFAULT_OI_TIMES = ['07:50', '09:55', '12:20'];
const DEFAULT_OI_SLOTS: OiSlot[] = ['open', 'mid', 'close'];
const DEFAULT_EXPIRY_SERIES_TIME = '06:30';
const WEEKDAY_NUMBERS = new Map([
  ['Sun', 0],
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6],
]);

function envBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value.toLowerCase() !== 'false' && value !== '0' && value !== 'no';
}

function envInteger(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}; received ${process.env[name] ?? 'undefined'}`);
  }
  return value;
}

function parseClockTime(value: string): { label: string; hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, hour, minute };
}

function parseClockTimes(value: string | undefined): Array<{ label: string; hour: number; minute: number }> {
  const raw = value ?? DEFAULT_OI_TIMES.join(',');
  const parsed = raw
    .split(',')
    .map(parseClockTime)
    .filter((time): time is { label: string; hour: number; minute: number } => time !== null);
  const unique = [...new Map(parsed.map((time) => [time.label, time])).values()]
    .sort((left, right) => left.hour * 60 + left.minute - right.hour * 60 - right.minute);
  return unique.length > 0 ? unique : DEFAULT_OI_TIMES.map((time) => parseClockTime(time)!);
}

function parseOiSlots(value: string | undefined): OiSlot[] {
  const parsed = (value ?? DEFAULT_OI_SLOTS.join(','))
    .split(',')
    .map((slot) => slot.trim())
    .filter((slot): slot is OiSlot => slot === 'open' || slot === 'mid' || slot === 'close');
  return parsed.length > 0 ? [...new Set(parsed)] : [...DEFAULT_OI_SLOTS];
}

function parseExpirySeriesTime(value: string | undefined): { label: string; hour: number; minute: number } {
  return parseClockTime(value ?? DEFAULT_EXPIRY_SERIES_TIME) ?? parseClockTime(DEFAULT_EXPIRY_SERIES_TIME)!;
}

function readConfig(): SchedulerConfig {
  const priceIntervalMinutes = envInteger('SCHEDULER_PRICE_INTERVAL_MINUTES', 15, 1);
  if (60 % priceIntervalMinutes !== 0) {
    throw new Error('SCHEDULER_PRICE_INTERVAL_MINUTES must divide evenly into 60');
  }
  return {
    runOnStart: envBoolean('SCHEDULER_RUN_ON_START', true),
    runExpirySeriesOnStart: envBoolean('SCHEDULER_EXPIRY_SERIES_RUN_ON_START', true),
    pollSeconds: envInteger('SCHEDULER_POLL_SECONDS', 30, 5),
    priceIntervalMinutes,
    priceTimeZone: process.env.SCHEDULER_PRICE_TIMEZONE ?? 'America/Chicago',
    oiTimeZone: process.env.SCHEDULER_OI_TIMEZONE ?? 'America/Chicago',
    oiTimes: parseClockTimes(process.env.SCHEDULER_OI_TIMES),
    oiSlots: parseOiSlots(process.env.SCHEDULER_OI_SLOTS),
    oiGraceMinutes: envInteger('SCHEDULER_OI_GRACE_MINUTES', 2, 0),
    expirySeriesTimeZone: process.env.SCHEDULER_EXPIRY_SERIES_TIMEZONE ?? 'America/Chicago',
    expirySeriesTime: parseExpirySeriesTime(process.env.SCHEDULER_EXPIRY_SERIES_TIME),
    expirySeriesGraceMinutes: envInteger('SCHEDULER_EXPIRY_SERIES_GRACE_MINUTES', 5, 0),
    dryRun: envBoolean('SCHEDULER_DRY_RUN', false),
  };
}

function clockParts(date: Date, timeZone: string): ZonedClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = new Map(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_NUMBERS.get(values.get('weekday') ?? '');
  if (weekday === undefined) throw new Error(`Unable to determine weekday in ${timeZone}`);
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (!year || !month || !day) throw new Error(`Unable to determine calendar date in ${timeZone}`);
  return {
    dateKey: `${year}-${month}-${day}`,
    hour: Number(values.get('hour') ?? 0),
    minute: Number(values.get('minute') ?? 0),
    weekday,
  };
}

function minuteOfDay(clock: ZonedClock): number {
  return clock.hour * 60 + clock.minute;
}

function isWeekday(clock: ZonedClock): boolean {
  return clock.weekday >= 1 && clock.weekday <= 5;
}

function priceSlotKey(date: Date, timeZone: string, intervalMinutes: number): string {
  const clock = clockParts(date, timeZone);
  const slotMinute = Math.floor(clock.minute / intervalMinutes) * intervalMinutes;
  return `${clock.dateKey}T${String(clock.hour).padStart(2, '0')}:${String(slotMinute).padStart(2, '0')}`;
}

function log(message: string): void {
  console.log(`[scheduler ${new Date().toISOString()}] ${message}`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let activeChild: ChildProcess | null = null;
let stopping = false;

async function execute(run: ScheduledRun, dryRun: boolean): Promise<void> {
  const label = run.kind === 'oi'
    ? `OI (${run.slot ?? 'open'})`
    : run.kind === 'expiry-series'
      ? 'contract / expiry series'
      : 'price + Thai Gold';
  if (dryRun) {
    log(`dry-run: ${label}`);
    return;
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RUN_LIVE_OI: run.kind === 'oi' ? 'true' : 'false',
    RUN_LIVE_THAI_GOLD: 'true',
  };
  if (run.kind === 'oi') environment.OI_SESSION_SLOTS = run.slot ?? 'open';

  log(`starting ${label}`);
  const command = run.kind === 'expiry-series' ? 'collector:expiry-series' : 'collector:run';
  const child = spawn(npmCommand, ['run', command], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
  });
  activeChild = child;

  await new Promise<void>((resolve) => {
    child.once('error', (error) => {
      console.error(`[scheduler ${new Date().toISOString()}] ${label} failed to start: ${error.message}`);
      resolve();
    });
    child.once('close', (code, signal) => {
      if (code === 0) log(`${label} completed successfully`);
      else console.error(`[scheduler ${new Date().toISOString()}] ${label} exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}; next schedule remains active`);
      resolve();
    });
  });
  if (activeChild === child) activeChild = null;
}

async function main(): Promise<void> {
  const config = readConfig();
  const pendingRuns: ScheduledRun[] = [];
  const queuedIds = new Set<string>();
  let draining = false;

  const drainQueue = async (): Promise<void> => {
    if (draining || stopping) return;
    draining = true;
    try {
      while (!stopping && pendingRuns.length > 0) {
        const run = pendingRuns.shift()!;
        try {
          await execute(run, config.dryRun);
        } finally {
          queuedIds.delete(run.id);
        }
      }
    } finally {
      draining = false;
      if (!stopping && pendingRuns.length > 0) void drainQueue();
    }
  };

  const enqueue = (run: ScheduledRun): void => {
    if (queuedIds.has(run.id)) return;
    queuedIds.add(run.id);
    pendingRuns.push(run);
    const label = run.kind === 'oi'
      ? `OI (${run.slot ?? 'open'})`
      : run.kind === 'expiry-series'
        ? 'contract / expiry series'
        : 'price + Thai Gold';
    log(`queued ${label}; pending=${pendingRuns.length}`);
    void drainQueue();
  };

  const now = new Date();
  let lastPriceSlot = priceSlotKey(now, config.priceTimeZone, config.priceIntervalMinutes);
  const completedOiRuns = new Set<string>();
  const completedExpirySeriesRuns = new Set<string>();

  log(`started; price every ${config.priceIntervalMinutes}m (${config.priceTimeZone}), OI ${config.oiTimes.map((time) => time.label).join(', ')} (${config.oiTimeZone}), expiry series ${config.expirySeriesTime.label} (${config.expirySeriesTimeZone}), poll=${config.pollSeconds}s`);
  if (config.dryRun) log('SCHEDULER_DRY_RUN=true; collector processes will not be started');
  if (config.runOnStart) enqueue({ id: `price:${lastPriceSlot}`, kind: 'price' });
  if (config.runExpirySeriesOnStart) {
    const startupExpiryClock = clockParts(now, config.expirySeriesTimeZone);
    completedExpirySeriesRuns.add(`expiry-series:${startupExpiryClock.dateKey}:${config.expirySeriesTime.label}`);
    enqueue({ id: `expiry-series:start:${startupExpiryClock.dateKey}`, kind: 'expiry-series' });
  }

  while (!stopping) {
    const current = new Date();
    const priceClock = clockParts(current, config.priceTimeZone);
    if (isWeekday(priceClock)) {
      const currentPriceSlot = priceSlotKey(current, config.priceTimeZone, config.priceIntervalMinutes);
      if (currentPriceSlot !== lastPriceSlot) {
        lastPriceSlot = currentPriceSlot;
        enqueue({ id: `price:${currentPriceSlot}`, kind: 'price' });
      }
    } else {
      lastPriceSlot = priceSlotKey(current, config.priceTimeZone, config.priceIntervalMinutes);
    }

    const oiClock = clockParts(current, config.oiTimeZone);
    if (isWeekday(oiClock)) {
      const currentMinute = minuteOfDay(oiClock);
      for (const [index, scheduled] of config.oiTimes.entries()) {
        const scheduledMinute = scheduled.hour * 60 + scheduled.minute;
        const delta = currentMinute - scheduledMinute;
        const runId = `oi:${oiClock.dateKey}:${scheduled.label}`;
        if (delta >= 0 && delta <= config.oiGraceMinutes && !completedOiRuns.has(runId)) {
          completedOiRuns.add(runId);
          enqueue({ id: runId, kind: 'oi', slot: config.oiSlots[index] ?? config.oiSlots.at(-1) ?? 'open' });
        }
      }
    }
    for (const runId of completedOiRuns) {
      if (!runId.includes(`:${oiClock.dateKey}:`)) completedOiRuns.delete(runId);
    }

    const expirySeriesClock = clockParts(current, config.expirySeriesTimeZone);
    if (isWeekday(expirySeriesClock)) {
      const currentMinute = minuteOfDay(expirySeriesClock);
      const scheduledMinute = config.expirySeriesTime.hour * 60 + config.expirySeriesTime.minute;
      const runId = `expiry-series:${expirySeriesClock.dateKey}:${config.expirySeriesTime.label}`;
      const delta = currentMinute - scheduledMinute;
      if (delta >= 0 && delta <= config.expirySeriesGraceMinutes && !completedExpirySeriesRuns.has(runId)) {
        completedExpirySeriesRuns.add(runId);
        enqueue({ id: runId, kind: 'expiry-series' });
      }
    }
    for (const runId of completedExpirySeriesRuns) {
      if (!runId.includes(`:${expirySeriesClock.dateKey}:`)) completedExpirySeriesRuns.delete(runId);
    }

    await sleep(config.pollSeconds * 1000);
  }

  while (draining) await sleep(100);
  log('stopped');
}

function requestStop(signal: string): void {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}; stopping after the active collector exits`);
  if (activeChild) activeChild.kill('SIGTERM');
}

process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

main().catch((error) => {
  console.error(`[scheduler ${new Date().toISOString()}] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});

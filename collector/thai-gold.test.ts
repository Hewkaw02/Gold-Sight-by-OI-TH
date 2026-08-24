import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThaiGoldPoints } from './thai-gold.js';
import { calculateThaiGoldPrice, THAI_GOLD_CONVERSION_FACTOR } from '../src/domain/thai-gold.js';
import type { PriceBar } from '../src/domain/types.js';

const bar = (date: string, close: number): PriceBar => ({
  time: `${date}T22:00:00Z`,
  closeTime: `${date}T23:00:00Z`,
  symbol: 'GC',
  timeframe: '1D',
  open: close,
  high: close,
  low: close,
  close,
  volume: null,
  source: 'test',
  sourceTimezone: 'America/Chicago',
  isClosed: true,
});

test('converts GC USD/oz to Thai baht-weight using the transparent unit formula', () => {
  const expected = Math.round((3_000 * 32 * THAI_GOLD_CONVERSION_FACTOR) / 50) * 50;
  assert.equal(calculateThaiGoldPrice(3_000, 32), expected);
  assert.equal(expected, 45_400);
});

test('builds one latest Thai gold point per Bangkok trading date', () => {
  const points = buildThaiGoldPoints([
    { asTime: '2026-08-12T09:00:00', bL_BuyPrice: 68_750, bL_SellPrice: 68_950, bahtPerUSD: 33.15 },
    { asTime: '2026-08-12T17:02:00', bL_BuyPrice: 68_850, bL_SellPrice: 69_050, bahtPerUSD: 33.06 },
  ], [bar('2026-08-11', 4_468.73)]);
  assert.equal(points.length, 1);
  assert.equal(points[0].actualSell, 69_050);
  assert.equal(points[0].gcPrice, 4_468.73);
  assert.equal(points[0].source, 'goldtraders.or.th');
});

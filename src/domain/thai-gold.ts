import type { PriceBar, ThaiGoldPoint } from './types.js';

export const THAI_GOLD_BAR_WEIGHT_GRAMS = 15.244;
export const THAI_GOLD_PURITY = 0.965;
export const TROY_OUNCE_GRAMS = 31.1034768;
export const THAI_GOLD_CONVERSION_FACTOR = THAI_GOLD_BAR_WEIGHT_GRAMS * THAI_GOLD_PURITY / TROY_OUNCE_GRAMS;

export const THAI_GOLD_FORMULA = 'GC USD/oz × USD/THB × (15.244 × 0.965 ÷ 31.1034768)';

export function roundThaiGoldPrice(value: number, increment = 50) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value / increment) * increment;
}

export function calculateThaiGoldPrice(gcPrice: number, usdThb: number, roundTo = 50) {
  return roundThaiGoldPrice(gcPrice * usdThb * THAI_GOLD_CONVERSION_FACTOR, roundTo);
}

export function calculatePremium(actualPrice: number, calculatedPrice: number) {
  const premium = actualPrice - calculatedPrice;
  return {
    baht: premium,
    pct: calculatedPrice === 0 ? 0 : premium / calculatedPrice,
  };
}

export function localDateKey(value: string, timeZone = 'Asia/Bangkok') {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(value));
}

export function buildThaiGoldPoint(
  asOf: string,
  actualBuy: number,
  actualSell: number,
  gcPrice: number,
  usdThb: number,
  source = 'goldtraders.or.th',
): ThaiGoldPoint {
  const calculatedPrice = calculateThaiGoldPrice(gcPrice, usdThb);
  const buyPremium = calculatePremium(actualBuy, calculatedPrice);
  const sellPremium = calculatePremium(actualSell, calculatedPrice);
  return {
    time: new Date(`${asOf.slice(0, 10)}T12:00:00+07:00`).toISOString(),
    asOf,
    actualBuy,
    actualSell,
    calculatedPrice,
    premiumToBuy: buyPremium.baht,
    premiumToBuyPct: buyPremium.pct,
    premiumToSell: sellPremium.baht,
    premiumToSellPct: sellPremium.pct,
    gcPrice,
    usdThb,
    source,
  };
}

export function priceBarDate(bar: PriceBar, timeZone = 'Asia/Bangkok') {
  return localDateKey(bar.time, timeZone);
}

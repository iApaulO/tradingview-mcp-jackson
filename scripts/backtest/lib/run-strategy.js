// Shared load+compute+simulate pipeline, used by both run-supertrend-backtest.js and
// run-harness.js so there's exactly one place this glue lives (matches the reasoning for
// reusing scripts/lib/adaptive-supertrend.js's calc itself: one code path, nothing to drift
// out of sync between scripts).

import { loadCandles } from "./load-candles.js";
import { calcATRSeries, computeAdaptiveSuperTrend, ATR_LEN } from "../../lib/adaptive-supertrend.js";
import { simulateSuperTrendFlipStrategy } from "./simulate-trades.js";
import { simulateMeanReversionStrategy } from "./simulate-mean-reversion.js";
import { calcBollingerBands } from "./bollinger.js";

export async function runSuperTrendStrategy(timeframeKey, { mode = "long-short" } = {}) {
  const candles = await loadCandles(timeframeKey);
  if (candles.length === 0) throw new Error(`No candles loaded for timeframe "${timeframeKey}" -- does the CSV exist?`);
  const atr = calcATRSeries(candles, ATR_LEN);
  const { dir } = computeAdaptiveSuperTrend(candles, atr);
  const trades = simulateSuperTrendFlipStrategy(candles, dir, { mode });
  return { candles, dir, trades };
}

// SuperTrend flip signal, filtered by Bollinger Band basis (20-SMA) agreement: only take a long
// entry if close is above the basis, only take a short if below. Standard "trend + trend" double
// confirmation -- rejects SuperTrend flips that fire against the medium-term trend as the BB
// basis approximates it, on the theory that those are more likely whipsaws.
export async function runSuperTrendBBStrategy(timeframeKey, { mode = "long-short", bbPeriod = 20, bbMult = 2 } = {}) {
  const candles = await loadCandles(timeframeKey);
  if (candles.length === 0) throw new Error(`No candles loaded for timeframe "${timeframeKey}" -- does the CSV exist?`);
  const atr = calcATRSeries(candles, ATR_LEN);
  const { dir } = computeAdaptiveSuperTrend(candles, atr);
  const { basis, upper, lower } = calcBollingerBands(candles, bbPeriod, bbMult);

  const entryFilter = (c, i, newSide) => {
    if (Number.isNaN(basis[i])) return false; // BB not warmed up yet -- stay flat rather than trade unfiltered
    return newSide === "long" ? c[i].c > basis[i] : c[i].c < basis[i];
  };

  const trades = simulateSuperTrendFlipStrategy(candles, dir, { mode, entryFilter });
  return { candles, dir, bands: { basis, upper, lower }, trades };
}

// Reversed combination role from runSuperTrendBBStrategy: BB drives entry timing (mean-reversion
// at the bands), SuperTrend only gates which direction is allowed and provides the trend-flip
// stop -- see simulate-mean-reversion.js for the full entry/exit logic.
export async function runMeanReversionStrategy(timeframeKey, { mode = "long-short", bbPeriod = 20, bbMult = 2 } = {}) {
  const candles = await loadCandles(timeframeKey);
  if (candles.length === 0) throw new Error(`No candles loaded for timeframe "${timeframeKey}" -- does the CSV exist?`);
  const atr = calcATRSeries(candles, ATR_LEN);
  const { dir } = computeAdaptiveSuperTrend(candles, atr);
  const bands = calcBollingerBands(candles, bbPeriod, bbMult);
  const trades = simulateMeanReversionStrategy(candles, dir, bands, { mode });
  return { candles, dir, bands, trades };
}

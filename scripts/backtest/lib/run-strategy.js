// Shared load+compute+simulate pipeline, used by both run-supertrend-backtest.js and
// run-harness.js so there's exactly one place this glue lives (matches the reasoning for
// reusing scripts/lib/adaptive-supertrend.js's calc itself: one code path, nothing to drift
// out of sync between scripts).

import { loadCandles } from "./load-candles.js";
import { calcATRSeries, computeAdaptiveSuperTrend, ATR_LEN } from "../../lib/adaptive-supertrend.js";
import { simulateSuperTrendFlipStrategy } from "./simulate-trades.js";

export async function runSuperTrendStrategy(timeframeKey, { mode = "long-short" } = {}) {
  const candles = await loadCandles(timeframeKey);
  if (candles.length === 0) throw new Error(`No candles loaded for timeframe "${timeframeKey}" -- does the CSV exist?`);
  const atr = calcATRSeries(candles, ATR_LEN);
  const { dir } = computeAdaptiveSuperTrend(candles, atr);
  const trades = simulateSuperTrendFlipStrategy(candles, dir, { mode });
  return { candles, dir, trades };
}

// First signal-bus for Adaptive SuperTrend. Thin wrapper -- reuses scripts/lib/adaptive-supertrend.js's
// calcATRSeries/computeAdaptiveSuperTrend EXACTLY (the K-Means/ATR math is already live-used and
// validated, not duplicated here). That module's `computeAdaptiveSuperTrend` returns per-bar `dir`
// (direction, -1/+1), `st` (the SuperTrend line value), `cluster` (0=high/1=medium/2=low volatility
// regime) series -- this file derives FLIP events (direction changes) from `dir`, matching the
// project's own convention of storing derived events, not raw per-bar series (EOT3 episodes not raw
// q5; SMC structure events not raw price).

import { calcATRSeries, computeAdaptiveSuperTrend, VOL_LABEL } from "../../lib/adaptive-supertrend.js";

const ATR_LEN = 10; // matches scripts/lib/adaptive-supertrend.js's own constant, kept separate from Boom Hunter/Cipher B's unrelated ATR(14) convention

// Public: SuperTrend flip events over a full candle series. Returns { events, series }.
// events: [{ direction: 'bullish'|'bearish', barIdx, time, price, volatilityRegime }] -- one per
// direction CHANGE (dir[i] !== dir[i-1]), not one per bar.
export function computeSuperTrendFlips(candles) {
  const atr = calcATRSeries(candles, ATR_LEN);
  const { dir, st, cluster } = computeAdaptiveSuperTrend(candles, atr);
  const n = candles.length;
  const events = [];
  let prevDir = null;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(dir[i])) continue;
    if (prevDir !== null && dir[i] !== prevDir) {
      events.push({
        direction: dir[i] === -1 ? "bullish" : "bearish",
        barIdx: i,
        time: candles[i].t,
        price: candles[i].c,
        volatilityRegime: Number.isNaN(cluster[i]) ? null : VOL_LABEL[cluster[i]],
      });
    }
    prevDir = dir[i];
  }
  return { events, series: { dir, st, cluster } };
}

// Simulates a SuperTrend-flip strategy over a precomputed direction series.
//
// Fill discipline: the flip at bar i is only knowable once bar i has closed (dir[i] depends on
// candles[i]'s own high/low and close). Filling at that same bar's close would be look-ahead --
// you can't trade a print you're simultaneously using to generate the signal. Fills happen at
// the OPEN of bar i+1 instead.
//
// mode: "long-short" (default, always in the market, flips direction) or "long-only" (flat
// during bearish stretches).
//
// entryFilter(candles, flipBarIdx, newSide) => boolean: optional gate on taking a NEW position
// when a flip occurs. Exits still always happen on a flip (no filter on getting out); a filtered
// entry just means staying flat until the next flip that passes. Defaults to always-true, which
// reproduces the unfiltered SuperTrend-alone behavior exactly -- used to combine with another
// indicator (e.g. Bollinger Bands, scripts/backtest/lib/bollinger.js) without touching this file
// again per combination.
//
// No position sizing, commission, or slippage modeling yet -- full-equity-per-trade compounding,
// zero costs. That's a deliberate Phase 2 simplification (proving the engine mechanics), not a
// claim about real tradability -- see ARCHITECTURE.md §6.

export function simulateSuperTrendFlipStrategy(candles, dir, { mode = "long-short", entryFilter = () => true } = {}) {
  const trades = [];
  let position = null;

  for (let i = 1; i < candles.length; i++) {
    if (Number.isNaN(dir[i]) || Number.isNaN(dir[i - 1]) || dir[i] === dir[i - 1]) continue;

    const newSide = dir[i] === -1 ? "long" : "short"; // -1 = bullish, 1 = bearish (adaptive-supertrend.js convention)
    const fillIdx = i + 1;
    if (fillIdx >= candles.length) break; // flip on the last bar has no next-bar fill available
    const fillPrice = candles[fillIdx].o;
    const fillTime = candles[fillIdx].t;

    if (position) {
      trades.push(closeTrade(position, fillPrice, fillTime, fillIdx));
      position = null;
    }

    const sideAllowed = mode === "long-short" || newSide === "long";
    if (sideAllowed && entryFilter(candles, i, newSide)) {
      position = { side: newSide, entryIdx: fillIdx, entryTime: fillTime, entryPrice: fillPrice };
    }
  }

  if (position) {
    const last = candles[candles.length - 1];
    trades.push(closeTrade(position, last.c, last.t, candles.length - 1, /* openAtEnd */ true));
  }

  return trades;
}

// Exported for reuse by other strategy shapes (e.g. simulate-mean-reversion.js) that need the
// same pnl/shape bookkeeping but different entry/exit trigger logic.
export function closeTrade(position, exitPrice, exitTime, exitIdx, openAtEnd = false, reason = "signal") {
  const pnlPct =
    position.side === "long"
      ? (exitPrice - position.entryPrice) / position.entryPrice
      : (position.entryPrice - exitPrice) / position.entryPrice;
  return {
    side: position.side,
    entryTime: position.entryTime,
    entryPrice: position.entryPrice,
    exitTime,
    exitPrice,
    pnlPct,
    barsHeld: exitIdx - position.entryIdx,
    openAtEnd,
    exitReason: reason,
  };
}

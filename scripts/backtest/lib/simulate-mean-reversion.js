// Mean-reversion entries at the Bollinger Bands, gated by SuperTrend as the trend filter --
// the reverse combination role from simulate-trades.js's entryFilter (which used SuperTrend as
// the primary signal and BB as a confirming filter). Here BB drives entry timing; SuperTrend
// only sets which direction is even allowed ("buy the dip in an uptrend, sell the rally in a
// downtrend"), never triggers the entry itself.
//
// Entry: SuperTrend bullish AND this bar's low touches/crosses the lower band -> long.
//        SuperTrend bearish AND this bar's high touches/crosses the upper band -> short.
//        ("Touch" = low <= lower / high >= upper, not requiring the close beyond it -- the
//        common, more inclusive definition, catches wicks into the band.)
// Exit:  whichever comes first -- price reverts to the basis (take profit), or SuperTrend flips
//        against the position (trend invalidated, cut it). Both are legitimate exits and are
//        tagged via exitReason so they can be told apart in the results.
//
// Same fill discipline as simulate-trades.js: signal confirmed on bar i's close, filled at bar
// i+1's open. Same simplifications: no position sizing/commission/slippage.

import { closeTrade } from "./simulate-trades.js";

export function simulateMeanReversionStrategy(candles, dir, bands, { mode = "long-short" } = {}) {
  const { basis, upper, lower } = bands;
  const trades = [];
  let position = null;

  for (let i = 1; i < candles.length; i++) {
    if (Number.isNaN(dir[i]) || Number.isNaN(basis[i])) continue;

    if (position) {
      const trendFlippedAgainst =
        (position.side === "long" && dir[i] === 1) || (position.side === "short" && dir[i] === -1);
      const revertedToBasis =
        (position.side === "long" && candles[i].h >= basis[i]) ||
        (position.side === "short" && candles[i].l <= basis[i]);

      if (trendFlippedAgainst || revertedToBasis) {
        const fillIdx = i + 1;
        if (fillIdx < candles.length) {
          trades.push(
            closeTrade(position, candles[fillIdx].o, candles[fillIdx].t, fillIdx, false, trendFlippedAgainst ? "trend_flip" : "basis_revert"),
          );
        }
        position = null;
      }
      continue; // one action per bar: don't also evaluate a fresh entry the same bar we exited
    }

    const longSignal = dir[i] === -1 && candles[i].l <= lower[i];
    const shortSignal = dir[i] === 1 && candles[i].h >= upper[i];

    let newSide = null;
    if (longSignal) newSide = "long";
    else if (shortSignal && mode === "long-short") newSide = "short";

    if (newSide) {
      const fillIdx = i + 1;
      if (fillIdx < candles.length) {
        position = { side: newSide, entryIdx: fillIdx, entryTime: candles[fillIdx].t, entryPrice: candles[fillIdx].o };
      }
    }
  }

  if (position) {
    const last = candles[candles.length - 1];
    trades.push(closeTrade(position, last.c, last.t, candles.length - 1, true, "open_at_end"));
  }

  return trades;
}

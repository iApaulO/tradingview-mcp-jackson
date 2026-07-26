// Liquidity-zone (EQH/EQL) sweep + reversal tracking. Equal highs/equal lows ARE the liquidity
// concept in SMC/ICT theory -- resting stop orders cluster above equal highs (buy-side liquidity)
// and below equal lows (sell-side liquidity) -- even though the word "liquidity" never appears in
// the source (confirmed by grep before writing this). calc.js only ever treated EQH/EQL as bare
// point events consumed as a confluence INPUT for order blocks; this file gives them the same
// analytical depth order blocks already have: does price come back and sweep the level (take the
// resting liquidity), and when it does, does it reverse (a stop-hunt, the classically interesting
// SMC signal) or just continue through (liquidity taken as part of an ongoing trend, not a
// manipulation signal)?
//
// Sweep: the first bar after confirmation where price actually trades through the level (EQH:
// high > level; EQL: low < level). Provably can't trigger on the confirmation bar itself or
// earlier -- by construction of the leg-pivot detection, every bar in [pivotBarIdx+1, confirmBarIdx]
// has a LOWER high (for EQH) / higher low (for EQL) than the pivot, since that's exactly what
// makes it a pivot in the first place. Starts scanning at confirmBarIdx+1 anyway, for a version of
// this file that doesn't have to rely on that proof holding under future changes.
//
// Reversal: within REVERSAL_WINDOW_BARS bars of the sweep, does price CLOSE back on the origin
// side of the level? A fixed bar-count window is a real simplification (ICT convention often
// looks for a structure shift/CHoCH instead) -- flagged as an assumption open to refinement, not
// presented as the only valid definition.

const REVERSAL_WINDOW_BARS = 10;

export function detectLiquiditySweeps(candles, eqhEqlEvents, { reversalWindowBars = REVERSAL_WINDOW_BARS } = {}) {
  for (const ev of eqhEqlEvents) {
    let sweepBarIdx = null;
    for (let i = ev.confirmBarIdx + 1; i < candles.length; i++) {
      const bar = candles[i];
      const swept = ev.side === "EQH" ? bar.h > ev.level : bar.l < ev.level;
      if (swept) {
        sweepBarIdx = i;
        break;
      }
    }

    if (sweepBarIdx == null) {
      ev.sweepStatus = "unswept";
      ev.sweepBarIdx = null;
      ev.sweepTime = null;
      ev.reversalBarIdx = null;
      ev.reversalTime = null;
      continue;
    }

    ev.sweepBarIdx = sweepBarIdx;
    ev.sweepTime = candles[sweepBarIdx].t;
    ev.barsToSweep = sweepBarIdx - ev.confirmBarIdx;

    let reversalBarIdx = null;
    const endCheck = Math.min(candles.length - 1, sweepBarIdx + reversalWindowBars);
    for (let j = sweepBarIdx; j <= endCheck; j++) {
      const backOnOriginSide = ev.side === "EQH" ? candles[j].c < ev.level : candles[j].c > ev.level;
      if (backOnOriginSide) {
        reversalBarIdx = j;
        break;
      }
    }

    ev.sweepStatus = reversalBarIdx != null ? "swept_reversed" : "swept_continued";
    ev.reversalBarIdx = reversalBarIdx;
    ev.reversalTime = reversalBarIdx != null ? candles[reversalBarIdx].t : null;
    ev.barsToReversal = reversalBarIdx != null ? reversalBarIdx - sweepBarIdx : null;
  }
  return eqhEqlEvents;
}

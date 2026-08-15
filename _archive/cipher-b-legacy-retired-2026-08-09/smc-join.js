// Joins each Cipher B divergence's confirming pivot against SMC structure_events (smc.db) on the
// same timeframe, separately for each scope -- internal (dashed) and swing (solid), confirmed
// against pine/smart-money-concepts-luxalgo.pine line 562 (`lineStyle = internal ? dashed : solid`),
// not inferred. Two scopes are matched independently (not "nearest regardless of scope") because
// iapaulo's own point was that solid vs dashed is itself the real datapoint -- collapsing them would
// throw away exactly the distinction being tested.
//
// Matched by TIME (unix seconds), not bar_idx -- cipher-b.db and smc.db are built from separate
// calc.js runs over the same loadCandles(key) source, and while their bar indexing should agree,
// time is the invariant ground truth and costs nothing extra to use instead.
//
// Same 0.2% price tolerance as every other proximity test in this project (confluence.js,
// cross-confluence-significance.js) -- not a new number. Time window is +-20 bars, self-scaling
// with timeframe since bar count is timeframe-relative already.

const PRICE_TOLERANCE_PCT = 0.002;
const TIME_WINDOW_BARS = 20;

// structureEvents: smc.db rows for one timeframe, already loaded. barDurationSec: seconds per bar
// on this timeframe (needed to convert the bar-window into a time-window, since structure_events
// only carries time, not this timeframe's own bar_idx).
export function joinDivergencesToSMC(divergences, structureEvents, barDurationSec) {
  const windowSec = TIME_WINDOW_BARS * barDurationSec;
  const bySide = { internal: structureEvents.filter((s) => s.scope === "internal"), swing: structureEvents.filter((s) => s.scope === "swing") };
  // Sort once per scope for reasonably fast nearest-in-window scans.
  for (const k of Object.keys(bySide)) bySide[k].sort((a, b) => a.time - b.time);

  const matches = [];
  for (const d of divergences) {
    for (const scope of ["internal", "swing"]) {
      const candidates = bySide[scope];
      let best = null, bestTimeDiff = Infinity;
      // Linear scan bounded by the time window -- structure_events per timeframe is small enough
      // (tens of thousands at most) that this is fast; a binary search isn't worth the complexity here.
      for (const s of candidates) {
        const timeDiff = Math.abs(s.time - d.time);
        if (timeDiff > windowSec) continue;
        const priceDiffPct = Math.abs(s.price - d.priceVal) / d.priceVal;
        if (priceDiffPct > PRICE_TOLERANCE_PCT) continue;
        if (timeDiff < bestTimeDiff) { best = s; bestTimeDiff = timeDiff; }
      }
      if (best) {
        matches.push({
          divergence: d,
          scope,
          structureType: best.type,
          structureSide: best.side,
          structureBarIdx: best.barIdx,
          structureTime: best.time,
          structurePrice: best.price,
          priceDiffPct: Math.abs(best.price - d.priceVal) / d.priceVal,
          timeDiffBars: Math.round(bestTimeDiff / barDurationSec),
        });
      }
    }
  }
  return matches;
}

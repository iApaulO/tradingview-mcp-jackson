// Forward-projects every divergence's line (slope + reference point, already computed in calc.js)
// past its confirming pivot and finds every bar where the REAL same-source oscillator series
// crosses it -- same-source only (a WT divergence's line is only meaningful against future WT2,
// not RSI/Stoch, matching how iapaulo's own manually-drawn line on Cipher B was checked against
// WT2, not a different series).
//
// Unbounded forward window, matching the source's own convention (`extendRight: true` on the
// manually-drawn line this was modeled on) -- NOT capped at some arbitrary lookback. Records every
// crossing over the line's full remaining life, not just the first, since a line can be broken and
// retested multiple times (the real 2026-07-31/08-01 break + 08-06/07 retest this was built to
// reproduce is exactly a 2-crossing case).
//
// Angle isn't a separate thing to compute here -- slope already lives on the parent `divergences`
// row (calc.js), and every crossing keeps its divergence_id, so "does a steep line get crossed
// sooner/later than a shallow one" is a plain join, not a new column.

export function computeCrossings(divergences, seriesBySource, candles) {
  const crossings = [];

  for (const d of divergences) {
    const series = seriesBySource[d.source];
    const m = d.slope;
    const b = d.oscVal - m * d.barIdx; // line(t) = m*t + b, passes through (barIdx, oscVal)

    let prevDiff = null;
    let crossingNum = 0;
    for (let t = d.barIdx + 1; t < series.length; t++) {
      const real = series[t];
      if (Number.isNaN(real)) continue;
      const projected = m * t + b;
      const diff = real - projected;

      if (prevDiff !== null && prevDiff !== 0 && diff !== 0 && (prevDiff < 0) !== (diff < 0)) {
        crossingNum++;
        crossings.push({
          divergence: d,
          crossingNum,
          barIdx: t,
          time: candles[t].t,
          barsSinceConfirm: t - d.confirmBarIdx,
          direction: prevDiff < 0 ? "below_to_above" : "above_to_below",
          oscValAtCross: real,
          projectedValAtCross: projected,
          priceAtCross: candles[t].c,
        });
      }
      prevDiff = diff;
    }
  }

  return crossings;
}

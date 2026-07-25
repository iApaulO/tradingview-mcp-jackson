// Random-entry Monte Carlo baseline -- the same method ARCHITECTURE.md §7 documents the SMC/ICT
// skeptic using against that methodology's own claimed edge. For each iteration, replays the
// real strategy's exact trade "shape" (same count, same long/short sides, same holding-period
// per trade) but with entry points picked uniformly at random from the historical data instead
// of from the actual SuperTrend signal. If the real strategy's result isn't meaningfully better
// than this distribution, the signal isn't adding anything a coin flip couldn't.
//
// Seeded PRNG (mulberry32) instead of Math.random() so runs are exactly reproducible -- matters
// for the experiment-tracking pillar (§6.6): a result should be re-derivable from its inputs.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// costParams: optional { takerFeePct, fundingPctPerHour } (same shape as lib/costs.js) -- applies
// the identical round-trip-fee + hours-held funding drag to EVERY random draw. Needed for an
// apples-to-apples significance test once costs are in the picture: comparing a costed real
// result against an uncosted random baseline (the original default) overstates significance,
// because costs shrink real and random results by different amounts (real's edge, if any, is a
// smaller fraction of its gross return than the random baseline's average is of its own gross).
export function randomEntryBaseline(candles, realTrades, { iterations = 1000, seed = 42, costParams = null } = {}) {
  const rng = mulberry32(seed);
  const finalEquities = [];

  for (let iter = 0; iter < iterations; iter++) {
    let equity = 1;
    for (const t of realTrades) {
      const holdBars = Math.max(1, t.barsHeld);
      const maxEntryIdx = candles.length - holdBars - 1;
      if (maxEntryIdx < 1) continue;
      const entryIdx = 1 + Math.floor(rng() * maxEntryIdx);
      const exitIdx = entryIdx + holdBars;
      const entryPrice = candles[entryIdx].o;
      const exitPrice = candles[exitIdx].o;
      let pnlPct =
        t.side === "long"
          ? (exitPrice - entryPrice) / entryPrice
          : (entryPrice - exitPrice) / entryPrice;
      if (costParams) {
        const hoursHeld = Math.max(0, (candles[exitIdx].t - candles[entryIdx].t) / 3600);
        pnlPct -= 2 * costParams.takerFeePct + costParams.fundingPctPerHour * hoursHeld;
      }
      equity *= 1 + pnlPct;
    }
    finalEquities.push(equity);
  }

  finalEquities.sort((a, b) => a - b);
  return finalEquities;
}

export function summarizeMonteCarlo(randomFinalEquities, realFinalEquity) {
  const n = randomFinalEquities.length;
  if (n === 0) return { iterations: 0 };

  const beatOrTiedReal = randomFinalEquities.filter((r) => r >= realFinalEquity).length;
  const below = randomFinalEquities.filter((r) => r < realFinalEquity).length;
  const mean = randomFinalEquities.reduce((s, x) => s + x, 0) / n;

  return {
    iterations: n,
    real_final_equity: realFinalEquity,
    random_mean_final_equity: mean,
    random_median_final_equity: randomFinalEquities[Math.floor(n / 2)],
    random_min: randomFinalEquities[0],
    random_max: randomFinalEquities[n - 1],
    real_percentile_rank: below / n, // e.g. 0.95 = real beat 95% of random-entry runs with the same trade shape
    p_value_random_beats_real: beatOrTiedReal / n, // fraction of random runs >= real; lower = more significant
    significant_at_5pct: beatOrTiedReal / n < 0.05,
  };
}

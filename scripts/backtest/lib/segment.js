// Splits a trade list (scripts/backtest/lib/simulate-trades.js output) into sub-periods, so
// computeMetrics() can be run per-segment instead of only on the whole history. Operates on the
// trade list, not the raw candles/indicator -- avoids re-running K-means training on a truncated
// window (which would silently produce a different SuperTrend calc than the full-history run,
// not just a different sample of the same one).

export function splitInSampleOutOfSample(trades, { ratio = 0.7 } = {}) {
  if (trades.length === 0) return { inSample: [], outOfSample: [], splitTime: null };
  const times = trades.map((t) => t.entryTime).sort((a, b) => a - b);
  const splitTime = times[Math.floor(times.length * ratio)];
  return {
    inSample: trades.filter((t) => t.entryTime < splitTime),
    outOfSample: trades.filter((t) => t.entryTime >= splitTime),
    splitTime,
  };
}

export function groupTradesByYear(trades) {
  const byYear = {};
  for (const t of trades) {
    const year = new Date(t.entryTime * 1000).getUTCFullYear();
    (byYear[year] ??= []).push(t);
  }
  return byYear;
}

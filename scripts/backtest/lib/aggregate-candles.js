// Aggregates a finer-timeframe candle series into a coarser one, UTC-bucket-aligned (matches
// standard exchange candle boundaries -- e.g. 3H buckets start at 00:00, 03:00, 06:00 UTC, not
// wherever the input series happens to start). Used where the historical data layer
// (data/historical/, see ARCHITECTURE.md §6) doesn't have a native table for a timeframe the
// signal bus's timeframe ladder needs -- currently just 3H (no T_3h in the source DB; 2H and
// everything else down to 1m does exist natively). Mirrors the same aggregation approach already
// used for synthesizing weekly bars from daily in scripts/lib/adaptive-supertrend.js.

export function aggregateCandles(candles, bucketSeconds) {
  const buckets = new Map();
  for (const c of candles) {
    const key = Math.floor(c.t / bucketSeconds) * bucketSeconds;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, bars]) => ({
      t,
      o: bars[0].o,
      h: Math.max(...bars.map((b) => b.h)),
      l: Math.min(...bars.map((b) => b.l)),
      c: bars[bars.length - 1].c,
      v: bars.reduce((s, b) => s + (b.v || 0), 0),
    }));
}

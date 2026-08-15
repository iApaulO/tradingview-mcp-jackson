// Aggregates a finer-timeframe candle series into a coarser one, UTC-bucket-aligned (matches
// standard exchange candle boundaries -- e.g. 3H buckets start at 00:00, 03:00, 06:00 UTC, not
// wherever the input series happens to start). Used where the historical data layer
// (data/historical/, see ARCHITECTURE.md §6) doesn't have a native table for a timeframe the
// signal bus's timeframe ladder needs -- currently just 3H (no T_3h in the source DB; 2H and
// everything else down to 1m does exist natively). Mirrors the same aggregation approach already
// used for synthesizing weekly bars from daily in scripts/lib/adaptive-supertrend.js.
//
// BUG FOUND 2026-08-09 (iapaulo doing a live weekly discretionary chart read, dates not matching
// the signal-bus): a plain `Math.floor(t/bucketSeconds)*bucketSeconds` anchors every bucket to
// the Unix epoch (1970-01-01T00:00:00Z), which was a THURSDAY -- fine for hour/day buckets
// (any UTC-midnight boundary is correct regardless of weekday), but wrong for 7-day (weekly)
// buckets specifically, since it silently produces Thursday-anchored weeks instead of the
// Monday-anchored weeks every live exchange/TradingView chart actually uses. Confirmed directly
// against the live chart (BITUNIX:BTCUSDT.P, 1W) before fixing -- real bars open Monday 00:00 UTC,
// the old binance-btc-1w.csv opened Thursday 00:00 UTC, a 3-day systematic offset on every weekly
// bar for the whole project's history. MONDAY_REF is the first Monday after epoch
// (1970-01-05T00:00:00Z); only the 7-day bucket case needs this adjustment.
const MONDAY_REF_SECONDS = Date.UTC(1970, 0, 5) / 1000;

export function aggregateCandles(candles, bucketSeconds) {
  const isWeekly = bucketSeconds === 7 * 86400;
  const anchor = isWeekly ? MONDAY_REF_SECONDS : 0;
  const buckets = new Map();
  for (const c of candles) {
    const key = Math.floor((c.t - anchor) / bucketSeconds) * bucketSeconds + anchor;
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

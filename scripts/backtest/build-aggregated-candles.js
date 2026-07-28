#!/usr/bin/env node
// Regenerates every synthesized (non-native) timeframe in the 8-TF signal-bus ladder from its
// finer native source, UTC-bucket-aligned (aggregate-candles.js). Supersedes build-3h-candles.js
// (kept for reference/compat, does the same 3H job alone) -- as of the 2025-01-01 Coinbase
// gap-fill, 2H/3H/4H/1W all need this treatment going forward, not just 3H: Coinbase's public API
// (unlike the old Binance source DB) has no native 2h/4h/1w granularity at all, only
// 1m/5m/15m/1h/6h/1d. Always regenerates the FULL series from the full native source (not an
// incremental append) -- simplest correct approach, cheap enough at these candle counts.
//
// Usage: node scripts/backtest/build-aggregated-candles.js

import { writeFileSync } from "fs";
import { loadCandles } from "./lib/load-candles.js";
import { aggregateCandles } from "./lib/aggregate-candles.js";

const JOBS = [
  { source: "1h", bucketSeconds: 2 * 3600, out: "2h" },
  { source: "1h", bucketSeconds: 3 * 3600, out: "3h" },
  { source: "1h", bucketSeconds: 4 * 3600, out: "4h" },
  { source: "1d", bucketSeconds: 7 * 86400, out: "1w" },
];

async function main() {
  const cache = new Map();
  for (const { source, bucketSeconds, out } of JOBS) {
    if (!cache.has(source)) cache.set(source, await loadCandles(source));
    const src = cache.get(source);
    const aggregated = aggregateCandles(src, bucketSeconds);
    const lines = ["timestamp,open,high,low,close,volume"];
    for (const c of aggregated) lines.push(`${new Date(c.t * 1000).toISOString()},${c.o},${c.h},${c.l},${c.c},${c.v}`);
    const outPath = new URL(`../../data/historical/binance-btc-${out}.csv`, import.meta.url);
    writeFileSync(outPath, lines.join("\n") + "\n");
    console.log(`${out}: ${aggregated.length.toLocaleString()} candles from ${source} (${src.length.toLocaleString()} source rows) -> ${outPath.pathname.replace(/^\/([A-Z]:)/, "$1")}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node
// One-time (re-runnable) synthesis of data/historical/binance-btc-3h.csv from the native 1H
// table -- the source DB (Binance_Historical_Data.db) has no T_3h. UTC-bucket-aligned (00:00,
// 03:00, 06:00 ... boundaries), same convention as scripts/lib/adaptive-supertrend.js's weekly
// synthesis from daily. Needed for the full W/D/4H/3H/2H/1H/15m/5m signal-bus timeframe ladder.
//
// Usage: node scripts/backtest/build-3h-candles.js

import { writeFileSync } from "fs";
import { loadCandles } from "./lib/load-candles.js";
import { aggregateCandles } from "./lib/aggregate-candles.js";

async function main() {
  const hourly = await loadCandles("1h");
  console.log(`Loaded ${hourly.length.toLocaleString()} 1H candles`);
  const threeHour = aggregateCandles(hourly, 3 * 3600);
  console.log(`Synthesized ${threeHour.length.toLocaleString()} 3H candles`);

  const lines = ["timestamp,open,high,low,close,volume"];
  for (const c of threeHour) {
    lines.push(`${new Date(c.t * 1000).toISOString()},${c.o},${c.h},${c.l},${c.c},${c.v}`);
  }
  const outPath = new URL("../../data/historical/binance-btc-3h.csv", import.meta.url);
  writeFileSync(outPath, lines.join("\n") + "\n");
  console.log(`Saved: ${outPath.pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node
// Full historical build across the confirmed 8-timeframe signal-bus ladder. First Adaptive
// SuperTrend signal-bus build -- computes flip events (direction changes) per timeframe, stores
// them in data/signal-bus/adaptive-supertrend.db. Always a full rebuild.
//
// Usage: node scripts/signal-bus/adaptive-supertrend/build-historical.js

import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSuperTrendFlips } from "./calc.js";
import { openStore, clearAll, insertRun, insertEvents } from "./store.js";

const LADDER = [
  { label: "W", key: "1w" },
  { label: "D", key: "1d" },
  { label: "4H", key: "4h" },
  { label: "3H", key: "3h" },
  { label: "2H", key: "2h" },
  { label: "1H", key: "1h" },
  { label: "15m", key: "15m" },
  { label: "5m", key: "5m" },
];

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

async function main() {
  const commit = gitCommit();
  const db = openStore();
  clearAll(db);

  const summary = [];
  for (const { label, key } of LADDER) {
    process.stdout.write(`${label.padEnd(4)} (${key}) ... `);
    const t0 = Date.now();
    const candles = await loadCandles(key);
    if (candles.length === 0) { console.log("SKIPPED (no candle data found)"); continue; }

    const { events } = computeSuperTrendFlips(candles);

    const runId = insertRun(db, { timeframe: key, candles, gitCommit: commit });
    insertEvents(db, { runId, timeframe: key, events });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const bullish = events.filter((e) => e.direction === "bullish").length;
    const bearish = events.filter((e) => e.direction === "bearish").length;
    console.log(`${candles.length.toLocaleString()} candles, ${events.length.toLocaleString()} flips (bullish=${bullish}, bearish=${bearish}) -- ${elapsed}s`);
    summary.push({ label, key, candles: candles.length, flips: events.length, bullish, bearish });
  }

  db.close();
  console.log("\nSummary:");
  console.table(summary);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

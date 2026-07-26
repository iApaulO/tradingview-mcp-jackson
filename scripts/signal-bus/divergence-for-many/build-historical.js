#!/usr/bin/env node
// Full historical build across the confirmed 8-timeframe signal-bus ladder (W, D, 4H, 3H, 2H, 1H,
// 15m, 5m -- 2026-07-25 discussion). Computes zones + touches per timeframe and stores them in
// data/signal-bus/divergence-for-many.db. Idempotent: clears each timeframe's prior rows before
// writing fresh ones, so re-running after a calc.js/touches.js change doesn't accumulate stale
// duplicate runs.
//
// Usage: node scripts/signal-bus/divergence-for-many/build-historical.js
//        node scripts/signal-bus/divergence-for-many/build-historical.js --tf=4h,1d   (subset)

import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeDivergenceForMany } from "./calc.js";
import { computeAllTouches } from "./touches.js";
import { openStore, saveRun, clearTimeframe } from "./store.js";

// Maps the confirmed timeframe ladder to data/historical/binance-btc-{key}.csv filenames.
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

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ONLY = args.tf ? args.tf.split(",") : null;

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  const commit = gitCommit();
  const db = openStore();
  const summary = [];

  for (const { label, key } of LADDER) {
    if (ONLY && !ONLY.includes(key) && !ONLY.includes(label)) continue;
    process.stdout.write(`${label.padEnd(4)} (${key}) ... `);
    const t0 = Date.now();
    const candles = await loadCandles(key);
    if (candles.length === 0) {
      console.log("SKIPPED (no candle data found)");
      continue;
    }
    const { badges, zones } = computeDivergenceForMany(candles);
    computeAllTouches(candles, zones);

    clearTimeframe(db, key);
    saveRun(db, { timeframe: key, candles, gitCommit: commit, zones, badges });

    const touches = zones.reduce((s, z) => s + z.touches.length, 0);
    const held = zones.reduce((s, z) => s + z.touches.filter((t) => t.outcome === "held").length, 0);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${candles.length.toLocaleString()} candles, ${zones.length} zones, ${touches} touches (${touches ? ((held / touches) * 100).toFixed(1) : "0.0"}% held) -- ${elapsed}s`);
    summary.push({ label, key, candles: candles.length, zones: zones.length, badges: badges.length, touches, held });
  }

  db.close();

  console.log("\nSummary:");
  console.table(summary);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node
// Phase 2 of ARCHITECTURE.md §6: prove the JS backtest engine end-to-end on SuperTrend --
// the simplest real case, since it's already independently reimplemented with no Pine
// dependency. Strategy: always-in-market long/short flip on Adaptive SuperTrend direction
// changes (or --mode=long-only to go flat instead of short).
//
// No anti-overfitting harness yet (walk-forward, Monte Carlo baseline, regime splits) -- that's
// Phase 3, built once and generically. This is raw, in-sample metrics only: proof the mechanics
// (data loading, indicator computation over history, trade simulation, metrics) are correct.
// Don't treat these numbers as evidence of edge.
//
// Usage:
//   node scripts/backtest/run-supertrend-backtest.js --tf=4h
//   node scripts/backtest/run-supertrend-backtest.js --tf=1d --mode=long-only

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { runSuperTrendStrategy } from "./lib/run-strategy.js";
import { computeMetrics } from "./lib/metrics.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const TIMEFRAME = args.tf || "4h";
const MODE = args.mode || "long-short";

const RESULTS_DIR = new URL("results/", import.meta.url);

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  console.log(`Loading data/historical/binance-btc-${TIMEFRAME}.csv, computing indicator, simulating (mode=${MODE})...`);
  const { candles, dir, trades } = await runSuperTrendStrategy(TIMEFRAME, { mode: MODE });
  const validBars = dir.filter((d) => !Number.isNaN(d)).length;
  console.log(`  ${candles.length.toLocaleString()} candles (${validBars.toLocaleString()} past warmup): ${new Date(candles[0].t * 1000).toISOString()} -> ${new Date(candles[candles.length - 1].t * 1000).toISOString()}`);
  console.log(`  ${trades.length} trades generated`);

  const metrics = computeMetrics(trades);

  // Pillar 5 (§6): a strategy result means little without a baseline. Buy-and-hold over the same
  // window is the cheapest one to compute, so it's always included, not left to be checked by hand.
  const buyAndHoldMultiple = candles[candles.length - 1].c / candles[0].c;
  metrics.buy_and_hold_multiple = buyAndHoldMultiple;
  metrics.beat_buy_and_hold = metrics.final_equity_multiple > buyAndHoldMultiple;

  const result = {
    strategy: "supertrend-flip",
    timeframe: TIMEFRAME,
    mode: MODE,
    data_range: {
      from: new Date(candles[0].t * 1000).toISOString(),
      to: new Date(candles[candles.length - 1].t * 1000).toISOString(),
      candle_count: candles.length,
    },
    metrics,
    generated_at: new Date().toISOString(),
    git_commit: gitCommit(),
    caveats: [
      "In-sample only -- no train/test split, no walk-forward, no out-of-sample validation yet (Phase 3).",
      "No random-entry Monte Carlo baseline compared against yet (Phase 3) -- do not read these numbers as evidence of edge.",
      "No position sizing, commission, or slippage modeled -- full-equity compounding, zero costs.",
      "Fills at next-bar open after signal confirmation (no look-ahead), but real execution would add slippage.",
    ],
  };

  console.log("\n--- Results ---");
  console.log(JSON.stringify(metrics, null, 2));

  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `supertrend-flip_${TIMEFRAME}_${MODE}_${result.generated_at.replace(/[:.]/g, "-")}.json`;
  const outPath = new URL(fname, RESULTS_DIR);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${outPath.pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

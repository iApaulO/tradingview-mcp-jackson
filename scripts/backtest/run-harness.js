#!/usr/bin/env node
// Phase 3 of ARCHITECTURE.md §6: the anti-overfitting harness, built once and generically.
// Takes a strategy's trade list and stress-tests it three ways before anyone gets to call it
// "edge":
//   1. In-sample / out-of-sample split -- does performance hold up on data it wasn't "seen" on?
//   2. Year-by-year regime breakdown -- one lucky year, or consistent across cycles?
//   3. Random-entry Monte Carlo baseline -- same trade count, same long/short sides, same
//      holding periods, but entries picked at random. The exact method §7 documents being used
//      against SMC/ICT's own claimed edge, turned on our own strategy first.
//
// Usage:
//   node scripts/backtest/run-harness.js --tf=4h --mode=long-only
//   node scripts/backtest/run-harness.js --tf=4h --mode=long-short --iterations=2000

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { runSuperTrendStrategy, runSuperTrendBBStrategy, runMeanReversionStrategy } from "./lib/run-strategy.js";
import { computeMetrics } from "./lib/metrics.js";
import { splitInSampleOutOfSample, groupTradesByYear } from "./lib/segment.js";
import { randomEntryBaseline, summarizeMonteCarlo } from "./lib/monte-carlo.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const TIMEFRAME = args.tf || "4h";
const MODE = args.mode || "long-short";
const ITERATIONS = parseInt(args.iterations || "1000", 10);
const SEED = parseInt(args.seed || "42", 10);
const STRATEGY = args.strategy || "supertrend";
const RUNNERS = { supertrend: runSuperTrendStrategy, "supertrend-bb": runSuperTrendBBStrategy, "mean-reversion": runMeanReversionStrategy };
if (!RUNNERS[STRATEGY]) throw new Error(`Unknown --strategy "${STRATEGY}" -- expected one of: ${Object.keys(RUNNERS).join(", ")}`);

const RESULTS_DIR = new URL("results/", import.meta.url);

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  console.log(`Loading data/historical/binance-btc-${TIMEFRAME}.csv, computing indicator (strategy=${STRATEGY}), simulating (mode=${MODE})...`);
  const { candles, trades } = await RUNNERS[STRATEGY](TIMEFRAME, { mode: MODE });
  console.log(`  ${candles.length.toLocaleString()} candles, ${trades.length} trades\n`);

  // --- 1. Full-period baseline (same as run-supertrend-backtest.js) ---
  const fullMetrics = computeMetrics(trades);
  const buyAndHoldMultiple = candles[candles.length - 1].c / candles[0].c;
  fullMetrics.buy_and_hold_multiple = buyAndHoldMultiple;
  fullMetrics.beat_buy_and_hold = fullMetrics.final_equity_multiple > buyAndHoldMultiple;
  console.log("--- Full period ---");
  console.log(`  trades=${fullMetrics.trade_count} net_return=${fullMetrics.net_return_pct?.toFixed(2)}x max_dd=${(fullMetrics.max_drawdown_pct * 100).toFixed(1)}% vs_buy_hold=${fullMetrics.beat_buy_and_hold ? "BEATS" : "loses to"} ${buyAndHoldMultiple.toFixed(2)}x`);

  // --- 2. In-sample / out-of-sample split ---
  const { inSample, outOfSample, splitTime } = splitInSampleOutOfSample(trades, { ratio: 0.7 });
  const isMetrics = computeMetrics(inSample);
  const oosMetrics = computeMetrics(outOfSample);
  console.log(`\n--- In-sample (70%, before ${new Date(splitTime * 1000).toISOString().slice(0, 10)}) ---`);
  console.log(`  trades=${isMetrics.trade_count} net_return=${isMetrics.net_return_pct?.toFixed(2)}x win_rate=${(isMetrics.win_rate * 100).toFixed(1)}%`);
  console.log(`--- Out-of-sample (30%, after) ---`);
  console.log(`  trades=${oosMetrics.trade_count} net_return=${oosMetrics.net_return_pct?.toFixed(2)}x win_rate=${(oosMetrics.win_rate * 100).toFixed(1)}%`);

  // --- 3. Year-by-year regime breakdown ---
  const byYear = groupTradesByYear(trades);
  const yearMetrics = {};
  console.log("\n--- By year ---");
  for (const [year, yearTrades] of Object.entries(byYear).sort()) {
    const m = computeMetrics(yearTrades);
    yearMetrics[year] = m;
    console.log(`  ${year}: trades=${m.trade_count} net_return=${m.net_return_pct?.toFixed(2)}x win_rate=${(m.win_rate * 100).toFixed(1)}%`);
  }

  // --- 4. Random-entry Monte Carlo baseline ---
  console.log(`\n--- Random-entry Monte Carlo (${ITERATIONS} iterations, seed=${SEED}) ---`);
  const randomResults = randomEntryBaseline(candles, trades, { iterations: ITERATIONS, seed: SEED });
  const mc = summarizeMonteCarlo(randomResults, fullMetrics.final_equity_multiple);
  console.log(`  real=${mc.real_final_equity.toFixed(2)}x  random mean=${mc.random_mean_final_equity.toFixed(2)}x median=${mc.random_median_final_equity.toFixed(2)}x range=[${mc.random_min.toFixed(2)}x, ${mc.random_max.toFixed(2)}x]`);
  console.log(`  real beat ${(mc.real_percentile_rank * 100).toFixed(1)}% of random-entry runs with the identical trade shape`);
  console.log(`  p-value (fraction of random runs >= real): ${mc.p_value_random_beats_real.toFixed(4)} ${mc.significant_at_5pct ? "(significant at 5%)" : "(NOT significant at 5% -- indistinguishable from random entries at this trade count)"}`);

  const result = {
    strategy: STRATEGY,
    timeframe: TIMEFRAME,
    mode: MODE,
    full_period: fullMetrics,
    in_sample: { ...isMetrics, split_time: new Date(splitTime * 1000).toISOString() },
    out_of_sample: oosMetrics,
    by_year: yearMetrics,
    monte_carlo: mc,
    generated_at: new Date().toISOString(),
    git_commit: gitCommit(),
    caveats: [
      "One instrument (Binance BTC spot proxy), one indicator, one simple flip rule -- not a general edge claim.",
      "IS/OOS split and year buckets both use the SAME full-history SuperTrend calc (K-means trained once, over everything) -- this tests consistency across periods, not true walk-forward re-optimization (nothing is re-fit per window).",
      "Monte Carlo baseline matches trade count/sides/holding-period shape, but not the specific timing correlation structure of real market regimes -- a stronger test than none, not a complete one.",
      "No position sizing, commission, or slippage modeled.",
    ],
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `harness_${STRATEGY}_${TIMEFRAME}_${MODE}_${result.generated_at.replace(/[:.]/g, "-")}.json`;
  const outPath = new URL(fname, RESULTS_DIR);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${outPath.pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

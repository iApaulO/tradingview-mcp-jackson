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
import { costSensitivitySweep } from "./lib/costs.js";

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

  // --- 5. Cost sensitivity sweep (gross vs. several fee/funding scenarios) ---
  // Neither fee tier nor funding magnitude is a confirmed account-specific number -- see
  // lib/costs.js header. This answers "does the edge survive ANY plausible cost level," not
  // "here is the exact net return," until the real Coinbase fee tier is confirmed.
  console.log("\n--- Cost sensitivity (full period, gross vs. costed scenarios) ---");
  const costSweep = costSensitivitySweep(trades);
  const costMetrics = {};
  for (const [name, { params, trades: costedTrades }] of Object.entries(costSweep)) {
    const m = computeMetrics(costedTrades);
    costMetrics[name] = { params, metrics: m };
    console.log(
      `  ${name.padEnd(34)} taker=${(params.takerFeePct * 100).toFixed(3)}% funding/hr=${(params.fundingPctPerHour * 100).toFixed(5)}%  net_return=${m.net_return_pct?.toFixed(2)}x  beats_buy_hold=${m.final_equity_multiple > buyAndHoldMultiple}`,
    );
  }

  // --- 6. Costed Monte Carlo re-test (retail worst-case tier) ---
  // Step 4's Monte Carlo compares a GROSS real result against an uncosted random baseline --
  // apples to oranges once costs matter this much (see §6 critique mitigation, 2026-07-25). This
  // applies the SAME cost model to every random draw as the real trades got, at the retail
  // worst-case tier (the decisive scenario from step 5), for a fair post-cost significance test.
  const retailParams = costMetrics.retail_worst_case.params;
  console.log(
    `\n--- Costed Random-entry Monte Carlo (retail worst-case: taker=${(retailParams.takerFeePct * 100).toFixed(2)}% funding/hr=${(retailParams.fundingPctPerHour * 100).toFixed(5)}%) ---`,
  );
  const costedRandomResults = randomEntryBaseline(candles, trades, { iterations: ITERATIONS, seed: SEED, costParams: retailParams });
  const costedRealFinalEquity = costMetrics.retail_worst_case.metrics.final_equity_multiple;
  const mcCosted = summarizeMonteCarlo(costedRandomResults, costedRealFinalEquity);
  console.log(
    `  real(costed)=${mcCosted.real_final_equity.toFixed(2)}x  random(costed) mean=${mcCosted.random_mean_final_equity.toFixed(2)}x median=${mcCosted.random_median_final_equity.toFixed(2)}x range=[${mcCosted.random_min.toFixed(2)}x, ${mcCosted.random_max.toFixed(2)}x]`,
  );
  console.log(`  real beat ${(mcCosted.real_percentile_rank * 100).toFixed(1)}% of costed random-entry runs with the identical trade shape`);
  console.log(
    `  p-value (costed, fraction of costed-random runs >= costed-real): ${mcCosted.p_value_random_beats_real.toFixed(4)} ${mcCosted.significant_at_5pct ? "(significant at 5%)" : "(NOT significant at 5% -- indistinguishable from random entries once both sides pay the same costs)"}`,
  );

  const result = {
    strategy: STRATEGY,
    timeframe: TIMEFRAME,
    mode: MODE,
    full_period: fullMetrics,
    in_sample: { ...isMetrics, split_time: new Date(splitTime * 1000).toISOString() },
    out_of_sample: oosMetrics,
    by_year: yearMetrics,
    monte_carlo: mc,
    cost_sensitivity: costMetrics,
    monte_carlo_costed_retail_worst_case: mcCosted,
    generated_at: new Date().toISOString(),
    git_commit: gitCommit(),
    caveats: [
      "One instrument (Binance BTC spot proxy), one indicator, one simple flip rule -- not a general edge claim.",
      "IS/OOS split and year buckets both use the SAME full-history SuperTrend calc (K-means trained once, over everything) -- this tests consistency across periods, not true walk-forward re-optimization (nothing is re-fit per window).",
      "Gross Monte Carlo (monte_carlo) matches trade count/sides/holding-period shape but compares GROSS real vs. GROSS random -- kept for reference, superseded for significance purposes by monte_carlo_costed_retail_worst_case.",
      "Costed Monte Carlo (monte_carlo_costed_retail_worst_case) applies the identical, still-UNCONFIRMED retail-worst-case fee/funding assumption to both sides -- see lib/costs.js. Neither Monte Carlo variant models real market regime correlation in the random draws.",
      "Cost sensitivity / costed Monte Carlo use an UNCONFIRMED fee tier (Coinbase's own fee/funding pages blocked automated fetch) and a cross-exchange representative funding rate, not Coinbase's own historical funding series. Treat as a sensitivity band, not a net-edge claim, until confirmed.",
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

#!/usr/bin/env node
// Direct follow-up to coarser-tf-pooled-significance.js: that script found a real, replicating
// directional edge (53.3-54.0% correct-direction at N=5/10/20 bars, p<0.0001, proportion test)
// pooled across 15m/1h/2h/3h/4h/1d regular divergence -- invisible to the standard mean-based
// z-test used everywhere else in this project because a handful of genuine, extreme historical
// outliers (bearish divergence signals blown through during the 2017 and Nov2020-Jan2021 BTC
// parabolic bull runs -- verified real price action, not a data bug) inflate variance enough to
// swamp a real but modest mean-based signal. A magnitude-robust test recovers it.
//
// That outlier-sensitivity problem does NOT carry over to a fixed-R:R cost test: a stop caps the
// loss on any single trade at -1R (before costs) regardless of how far price ran against the
// position, so the same historical blow-off-top trades that distorted the significance test's mean
// simply resolve as ordinary stopped-out losses here, not extreme uncapped negative outliers.
//
// Motivation checked directly before building this (not assumed): fee-as-fraction-of-0.6xATR(14)-
// risk drops from 88.6% on 5m to 24.3% on 1h and 11.9% on 4h -- if this edge is real, it has a much
// better chance of clearing costs here than anything found on 5m in §29/§30.
//
// Same trade construction as every fixed-R:R test in this project: entry = next-bar-open after the
// divergence zone's own confirmation bar; risk = 0.6x ATR(14) at that bar (each timeframe's own
// candles); stop = entry -/+ risk; target = entry +/- R x risk; race-to-target-or-stop, R in
// {1, 1.5, 2, 3}, max 200 bars, same-bar ambiguity -> stop; real costs from #22 (register), reused.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/coarser-tf-divergence-cost-capacity-backtest.js [--r=1,1.5,2,3]

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeVmcCipherB } from "./calc.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const LADDER = ["15m", "1h", "2h", "3h", "4h", "1d"]; // same pooled set as coarser-tf-pooled-significance.js
const ATR_LEN = 14;
const ATR_MULT = 0.6;
const MAX_HOLD_BARS = 200;

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function atr(candles, length) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < length) return out;
  let seed = 0;
  for (let i = 0; i < length; i++) seed += tr[i];
  out[length - 1] = seed / length;
  for (let i = length; i < candles.length; i++) out[i] = (out[i - 1] * (length - 1) + tr[i]) / length;
  return out;
}

function simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice) {
  const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= endCheck; j++) {
    const bar = candles[j];
    const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
    const hitTarget = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
    if (hitStop) return { exitPrice: stopPrice, exitTime: bar.t, outcome: "stop" };
    if (hitTarget) return { exitPrice: targetPrice, exitTime: bar.t, outcome: "target" };
  }
  return null;
}

function expectancy(trades) {
  return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null;
}

async function main() {
  const perTf = {};
  console.log("=== Per-timeframe event counts (regular divergence) ===");
  for (const tf of LADDER) {
    const candles = await loadCandles(tf);
    const atr14 = atr(candles, ATR_LEN);
    const { zones } = computeVmcCipherB(candles);
    const regularZones = zones.filter((z) => z.kind === "regular");
    perTf[tf] = { candles, atr14, zones: regularZones };
    console.log(`  ${tf}: ${regularZones.length} events`);
  }

  const confirmedParams = { takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const allResults = {};

  for (const rMult of R_MULTIPLES) {
    console.log(`\n========== R-multiple target: ${rMult}R (risk = ${ATR_MULT}x ATR(${ATR_LEN}), each timeframe's own candles) ==========`);
    const tradesByTf = {};
    let totalInconclusive = 0;

    for (const tf of LADDER) {
      const { candles, atr14, zones } = perTf[tf];
      const n = candles.length;
      const tfTrades = [];
      for (const z of zones) {
        const i = z.confirmedBarIdx;
        const entryIdx = i + 1;
        if (entryIdx >= n || !Number.isFinite(atr14[i]) || atr14[i] <= 0) continue;
        const entryPrice = candles[entryIdx].o;
        const entryTime = candles[entryIdx].t;
        const side = z.side === "bullish" ? "long" : "short";
        const risk = ATR_MULT * atr14[i];
        const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
        const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;
        const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
        if (!result) { totalInconclusive++; continue; }
        const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
        tfTrades.push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, timeframe: tf });
      }
      tradesByTf[tf] = tfTrades;
    }

    function reportBucket(label, bucketTrades) {
      if (bucketTrades.length < 30) { console.log(`  ${label}: n=${bucketTrades.length} (too thin to trust)`); return null; }
      const gross = computeMetrics(bucketTrades);
      const costedTrades = applyCosts(bucketTrades, confirmedParams);
      const grossExp = expectancy(bucketTrades);
      const costedExp = expectancy(costedTrades);
      console.log(
        `  ${label.padEnd(14)} n=${String(gross.trade_count).padEnd(6)} win=${(gross.win_rate * 100).toFixed(1)}%  PF=${gross.profit_factor?.toFixed(2)}  gross_exp=${(grossExp * 100).toFixed(4)}%/trade  costed_exp=${(costedExp * 100).toFixed(4)}%/trade ${costedExp > 0 ? "(clears costs)" : ""}`,
      );
      return { trade_count: gross.trade_count, win_rate: gross.win_rate, profit_factor: gross.profit_factor, gross_expectancy_pct_per_trade: grossExp, costed_expectancy_pct_per_trade: costedExp };
    }

    console.log("\n-- Per timeframe --");
    const rResult = { perTimeframe: {} };
    for (const tf of LADDER) rResult.perTimeframe[tf] = reportBucket(tf, tradesByTf[tf]);

    console.log("\n-- Pooled (all 6 timeframes combined) --");
    const pooledTrades = LADDER.flatMap((tf) => tradesByTf[tf]);
    rResult.pooled = reportBucket("pooled", pooledTrades);

    console.log("\n-- Pooled excluding 1d (thinnest leg, dominated by 2017/2020-21 outlier regimes in the significance test) --");
    const pooledNo1d = LADDER.filter((tf) => tf !== "1d").flatMap((tf) => tradesByTf[tf]);
    rResult.pooledNo1d = reportBucket("pooled (no 1d)", pooledNo1d);

    allResults[`${rMult}R`] = { ...rResult, inconclusive: totalInconclusive };
  }

  const spanSeconds = perTf["1h"].candles[perTf["1h"].candles.length - 1].t - perTf["1h"].candles[0].t;
  const spanYears = spanSeconds / (365.25 * 86400);
  console.log(`\n=== Capacity ===\n  data span: ${spanYears.toFixed(2)} years`);
  for (const tf of LADDER) console.log(`  ${tf}: ${perTf[tf].zones.length} events (${(perTf[tf].zones.length / spanYears).toFixed(1)}/yr)`);
  const totalEvents = LADDER.reduce((s, tf) => s + perTf[tf].zones.length, 0);
  console.log(`  pooled: ${totalEvents} events (${(totalEvents / spanYears).toFixed(1)}/yr)`);

  const result = {
    scope: "Cipher B regular WT divergence, pooled 15m/1h/2h/3h/4h/1d",
    trade_construction: `entry = next-bar-open after the divergence zone's own confirmation bar (each timeframe's own candles); risk R = ${ATR_MULT}x ATR(${ATR_LEN}) at that bar; stop = entry -/+ R; target = entry +/- R-multiple x R; race-to-target-or-stop, max ${MAX_HOLD_BARS} bars, same-bar ambiguity scored as the stop`,
    r_multiples_tested: R_MULTIPLES,
    data_span_years: spanYears,
    results: allResults,
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `coarser_tf_divergence_cost_capacity_backtest_${result.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node
// Direct follow-up to §29 (cost-capacity-backtest.js): every cost/capacity test run so far entered
// off buySignal/sellSignal, using divergence only as a CONFIRMING FILTER on top of that entry
// (§28/#45). Divergence itself has never been cost-tested as its own standalone entry -- this
// fills that gap, since iapaulo's original question ("the significance of divergence") is about
// divergence as a signal in its own right, not just as a booster for a different entry.
//
// Scope: Cipher B REGULAR WT divergence only (hidden showed no significance anywhere, §33/#33 --
// not re-tested here), 5-minute only (the ONLY timeframe with a real, replicated effect, §35/#35 --
// testing other timeframes here would just repeat that null, already established).
//
// Same trade construction as §29/#46 throughout (the only construction that's ever cleared costs
// in this project): entry = next-bar-open after the divergence zone's own confirmation bar; risk =
// 0.6x ATR(14) at that bar; stop = entry -/+ risk; target = entry +/- R x risk; race-to-target-or-
// stop, R in {1, 1.5, 2, 3}, max 200 bars, same-bar ambiguity -> stop. Real costs from #22, reused.
//
// Two entry variants tested:
//   1. Raw divergence entry -- the direct standalone test iapaulo is asking about.
//   2. Divergence entry ALSO near a same-side buySignal/sellSignal within 10 bars (either order --
//      unlike §28's past-only construction, here BOTH orderings are look-ahead-safe: if the
//      confirming buySignal/sellSignal came first, that's public info by the divergence's own
//      confirmation bar; if it comes after, it's irrelevant to this entry's own trade -- included
//      only as a descriptive comparison against variant 1, not a claim requiring look-ahead-safety
//      the way "does event X predict outcome Y" claims do elsewhere in this project.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/divergence-cost-capacity-backtest.js [--r=1,1.5,2,3]

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeVmcCipherB, computeWtCrossSignals } from "./calc.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const TF = "5m";
const ATR_LEN = 14;
const ATR_MULT = 0.6;
const MAX_HOLD_BARS = 200;
const NEARBY_WINDOW = 10;

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
  const candles = await loadCandles(TF);
  const n = candles.length;
  const atr14 = atr(candles, ATR_LEN);
  const { zones } = computeVmcCipherB(candles);
  const regularZones = zones.filter((z) => z.kind === "regular");
  console.log(`${TF}: ${regularZones.length} Cipher B regular WT divergence events (hidden excluded -- no established significance, §33)\n`);

  const { events: buySellEvents } = computeWtCrossSignals(candles);
  const bsBySide = {
    bullish: buySellEvents.filter((e) => e.side === "bullish").map((e) => e.confirmedBarIdx).sort((a, b) => a - b),
    bearish: buySellEvents.filter((e) => e.side === "bearish").map((e) => e.confirmedBarIdx).sort((a, b) => a - b),
  };
  function nearBuySell(side, barIdx, window) {
    const list = bsBySide[side];
    // binary-search-free linear scan is fine here (list sizes are ~22k, called ~45k times total across all zones -- same cost class as prior scripts in this file)
    for (const b of list) {
      if (Math.abs(b - barIdx) <= window) return true;
      if (b > barIdx + window) break;
    }
    return false;
  }

  const labeled = regularZones.map((z) => {
    const i = z.confirmedBarIdx;
    return { ...z, entryIdx: i + 1, atrAtSignal: atr14[i], nearBuySell: nearBuySell(z.side, i, NEARBY_WINDOW) };
  }).filter((z) => z.entryIdx < n && Number.isFinite(z.atrAtSignal) && z.atrAtSignal > 0);
  console.log(`${labeled.length} events with valid ATR(14) and a tradeable next-bar entry\n`);

  const confirmedParams = { takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const allResults = {};

  for (const rMult of R_MULTIPLES) {
    console.log(`\n========== R-multiple target: ${rMult}R (risk = ${ATR_MULT}x ATR(${ATR_LEN}) at the divergence's own confirmation bar) ==========`);
    const trades = [];
    let inconclusive = 0;
    for (const z of labeled) {
      const entryPrice = candles[z.entryIdx].o;
      const entryTime = candles[z.entryIdx].t;
      const side = z.side === "bullish" ? "long" : "short";
      const risk = ATR_MULT * z.atrAtSignal;
      const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
      const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;
      const result = simulateFixedR(candles, z.entryIdx, side, stopPrice, targetPrice);
      if (!result) { inconclusive++; continue; }
      const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
      trades.push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, nearBuySell: z.nearBuySell });
    }
    console.log(`${trades.length} resolved, ${inconclusive} inconclusive`);

    function reportBucket(label, bucketTrades) {
      if (bucketTrades.length < 30) { console.log(`  ${label}: n=${bucketTrades.length} (too thin)`); return null; }
      const gross = computeMetrics(bucketTrades);
      const costedTrades = applyCosts(bucketTrades, confirmedParams);
      const grossExp = expectancy(bucketTrades);
      const costedExp = expectancy(costedTrades);
      console.log(
        `  ${label.padEnd(28)} n=${String(gross.trade_count).padEnd(6)} win=${(gross.win_rate * 100).toFixed(1)}%  PF=${gross.profit_factor?.toFixed(2)}  gross_exp=${(grossExp * 100).toFixed(4)}%/trade  costed_exp=${(costedExp * 100).toFixed(4)}%/trade ${costedExp > 0 ? "(clears costs)" : ""}`,
      );
      return { trade_count: gross.trade_count, win_rate: gross.win_rate, profit_factor: gross.profit_factor, gross_expectancy_pct_per_trade: grossExp, costed_expectancy_pct_per_trade: costedExp };
    }

    console.log("\n-- 1. Raw divergence entry (standalone) --");
    const rResult = { raw: reportBucket("all regular divergence", trades) };

    console.log("\n-- 2. Split by nearby buySignal/sellSignal (descriptive comparison only) --");
    rResult.nearBuySell = {
      not_near: reportBucket("no nearby buy/sell signal", trades.filter((t) => !t.nearBuySell)),
      near: reportBucket("nearby buy/sell signal", trades.filter((t) => t.nearBuySell)),
    };

    allResults[`${rMult}R`] = { ...rResult, inconclusive, total_resolved: trades.length };
  }

  const spanSeconds = candles[n - 1].t - candles[0].t;
  const spanYears = spanSeconds / (365.25 * 86400);
  console.log(`\n=== Capacity ===\n  data span: ${spanYears.toFixed(2)} years\n  raw divergence events: ${labeled.length} (${(labeled.length / spanYears).toFixed(1)}/yr)`);

  const result = {
    scope: "Cipher B regular WT divergence, 5-minute only",
    trade_construction: `entry = next-bar-open after the divergence zone's own confirmation bar; risk R = ${ATR_MULT}x ATR(${ATR_LEN}) at that bar; stop = entry -/+ R; target = entry +/- R-multiple x R; race-to-target-or-stop, max ${MAX_HOLD_BARS} bars, same-bar ambiguity scored as the stop`,
    r_multiples_tested: R_MULTIPLES,
    data_span_years: spanYears,
    results: allResults,
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `divergence_cost_capacity_backtest_${result.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

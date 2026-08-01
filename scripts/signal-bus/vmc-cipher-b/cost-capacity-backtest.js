#!/usr/bin/env node
// Cost/capacity test for the Cipher B buySignal/sellSignal findings that survived the video-driven
// significance-testing pass (§19-§28) -- iapaulo's explicit direction (2026-07-31): don't cost-test
// until the understanding-building phase is done, then cost the survivors. This is that pass.
//
// Trade construction reuses the exact convention already established for cross-confluence/
// breakout-bias-backtest.js and smc/recurrence-backtest-fixed-rr.js (naive construction has failed
// every single house-stack finding tested so far -- #2/#2a, #4a, #25a -- so go straight to fixed
// R:R, the one construction that has ever cleared real costs, #27b):
//   - entry = next-bar-open after the signal's own bar (the signal fires at candle close; entry
//     one bar later is the earliest tradeable fill, no look-ahead)
//   - risk R = 0.6x ATR(14) at the signal bar -- same ATR length/multiplier already used for
//     Divergence-for-Many's own badge/glow dedup tolerance and reused for breakout-bias-backtest.js,
//     not a new invented number
//   - stop = entry -/+ R; target = entry +/- R-multiple x R; race to whichever hits first
//   - same-bar ambiguity (both stop and target's price levels touched within one bar) scored
//     conservatively as the stop, matching every other fixed-R:R test in this project
//   - max hold 200 bars (~16.7h on 5m) as an inconclusive-trade backstop, not a target itself
//
// Costs: real, confirmed Coinbase Advanced 1 tier figures from costs.js (#22 in the register) --
// reused, not re-derived. Reported metric is the non-compounding arithmetic-mean per-trade
// expectancy (win_rate*avg_win - (1-win_rate)*avg_loss), NOT computeMetrics' net_return_pct/
// final_equity_multiple -- those assume sequential full-equity compounding, invalid here since
// buySignal/sellSignal fires ~1 per 21 bars on 5m and adjacent trades can genuinely overlap in
// holding period (the exact trap already caught in #25a).
//
// Stratifications tested, each independently bucketing the SAME simulated trade set (labels
// attached per-event before simulation, all read at-or-before the signal's own bar -- no
// look-ahead in any label):
//   1. ALL events (baseline reference, replicates §19/#36's raw signal)
//   2. confirm-count (0/1/2/3+ higher-TF confirmations, §21/#38 -- the strongest single finding)
//   3. wt2-extremity bucket (53-70/70-80/80-100/100+, §27/#44 -- the inverted-U)
//   4. recent same-side regular divergence, past 10 bars (§28/#45 Part 2)
//   5. COMBINED: wt2 in the 70-80 peak band AND recent divergence -- §28's single strongest,
//      most specific entry description, the leading candidate for this whole investigation
//   6. prior yellowCross within 10 bars (§22/#39 corrected -- weaker, secondary finding)
//
// Usage: node scripts/signal-bus/vmc-cipher-b/cost-capacity-backtest.js [--r=1,1.5,2,3]

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeWtCrossSignals, computeWaveTrend, computeVmcCipherB } from "./calc.js";
import { computeYellowCross } from "../vmc-cipher-a/calc.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const TF = "5m";
const ATR_LEN = 14;
const ATR_MULT = 0.6;
const MAX_HOLD_BARS = 200;
const HIGHER_LADDER = ["15m", "1h", "2h", "3h", "4h", "1d", "1w"];
const TF_SECONDS = { "5m": 300, "15m": 900, "1h": 3600, "2h": 7200, "3h": 10800, "4h": 14400, "1d": 86400, "1w": 604800 };
const LOOKBACK_BARS = 3;
const DIV_WINDOW = 10;
const YELLOWX_WINDOW = 10;

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// Wilder RMA ATR -- identical formula to smc/calc.js's atr() and divergence-for-many/calc.js's
// badge-glow ATR, just inlined here to avoid a cross-signal-bus-directory import.
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
    if (hitStop) return { exitPrice: stopPrice, exitTime: bar.t, outcome: "stop" }; // same-bar ambiguity -> stop, conservative
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
  const { events: baseEvents } = computeWtCrossSignals(candles);
  const { wt2 } = computeWaveTrend(candles);
  const atr14 = atr(candles, ATR_LEN);
  console.log(`${TF}: ${baseEvents.length} Cipher B buySignal/sellSignal events\n`);

  // ── Labels, each read at-or-before the signal's own bar (no look-ahead) ──

  // 1. Multi-TF confirm-count (§21/#38's exact two-pointer construction)
  const higherEvents = {};
  for (const tf of HIGHER_LADDER) {
    const c = await loadCandles(tf);
    if (c.length === 0) continue;
    higherEvents[tf] = computeWtCrossSignals(c).events;
  }
  const pointers = {}; for (const tf of HIGHER_LADDER) pointers[tf] = { lo: 0, hi: 0 };
  const confirmCount = baseEvents.map((e) => {
    const t = e.confirmedTime;
    let count = 0;
    for (const tf of HIGHER_LADDER) {
      const list = higherEvents[tf];
      if (!list) continue;
      const windowSec = LOOKBACK_BARS * TF_SECONDS[tf];
      const p = pointers[tf];
      while (p.hi < list.length && list[p.hi].confirmedTime <= t) p.hi++;
      while (p.lo < p.hi && list[p.lo].confirmedTime < t - windowSec) p.lo++;
      for (let k = p.lo; k < p.hi; k++) { if (list[k].side === e.side) { count++; break; } }
    }
    return count;
  });

  // 2. wt2 extremity bucket at the signal bar (§27/#44)
  function extremityBucket(v) {
    const a = Math.abs(v);
    if (a < 70) return "53-70";
    if (a < 80) return "70-80";
    if (a < 100) return "80-100";
    return "100+";
  }

  // 3. Recent same-side regular divergence, past-only (§28/#45 Part 2)
  const { zones } = computeVmcCipherB(candles);
  const divBySide = {
    bullish: zones.filter((z) => z.kind === "regular" && z.side === "bullish").map((z) => z.confirmedBarIdx).sort((a, b) => a - b),
    bearish: zones.filter((z) => z.kind === "regular" && z.side === "bearish").map((z) => z.confirmedBarIdx).sort((a, b) => a - b),
  };
  function nearDivergence(side, barIdx, window) {
    for (const b of divBySide[side]) { if (b > barIdx) break; if (barIdx - b <= window) return true; }
    return false;
  }

  // 4. Prior yellowCross within window, past-only (§22/#39 corrected -- warning is BEARISH-only in
  // the source, checked against both sides same as yellowx-veto-significance.js)
  const { events: yxEvents } = computeYellowCross(candles);
  const yxSorted = yxEvents.map((e) => e.barIdx).sort((a, b) => a - b);
  function nearYellowX(barIdx, window) {
    for (const yx of yxSorted) { if (yx > barIdx) break; if (barIdx - yx <= window) return true; }
    return false;
  }

  // ── Attach all labels, filter to events with valid ATR and next-bar entry available ──
  const labeled = baseEvents.map((e, idx) => {
    const i = e.confirmedBarIdx;
    const entryIdx = i + 1;
    return {
      ...e,
      entryIdx,
      atrAtSignal: atr14[i],
      confirmCount: confirmCount[idx],
      extremityBucket: extremityBucket(wt2[i]),
      divConfluent: nearDivergence(e.side, i, DIV_WINDOW),
      yellowXPrior: nearYellowX(i, YELLOWX_WINDOW),
    };
  }).filter((e) => e.entryIdx < n && Number.isFinite(e.atrAtSignal) && e.atrAtSignal > 0);
  console.log(`${labeled.length} events with valid ATR(14) and a tradeable next-bar entry (of ${baseEvents.length} raw)\n`);

  const confirmedParams = { takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const allResults = {};

  for (const rMult of R_MULTIPLES) {
    console.log(`\n========== R-multiple target: ${rMult}R (risk = ${ATR_MULT}x ATR(${ATR_LEN}) at signal bar) ==========`);
    const trades = [];
    let inconclusive = 0;

    for (const e of labeled) {
      const entryPrice = candles[e.entryIdx].o;
      const entryTime = candles[e.entryIdx].t;
      const side = e.side === "bullish" ? "long" : "short";
      const risk = ATR_MULT * e.atrAtSignal;
      const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
      const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;
      const result = simulateFixedR(candles, e.entryIdx, side, stopPrice, targetPrice);
      if (!result) { inconclusive++; continue; }
      const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
      trades.push({
        side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct,
        resolvedAs: result.outcome, confirmCount: e.confirmCount, extremityBucket: e.extremityBucket,
        divConfluent: e.divConfluent, yellowXPrior: e.yellowXPrior,
      });
    }
    console.log(`${trades.length} resolved trades, ${inconclusive} inconclusive (neither target nor stop hit within ${MAX_HOLD_BARS} bars)`);

    function reportBucket(label, bucketTrades) {
      if (bucketTrades.length < 30) { console.log(`  ${label}: n=${bucketTrades.length} (too thin to trust)`); return null; }
      const gross = computeMetrics(bucketTrades);
      const costedTrades = applyCosts(bucketTrades, confirmedParams);
      const grossExp = expectancy(bucketTrades);
      const costedExp = expectancy(costedTrades);
      console.log(
        `  ${label.padEnd(28)} n=${String(gross.trade_count).padEnd(6)} win=${(gross.win_rate * 100).toFixed(1)}%  PF=${gross.profit_factor?.toFixed(2)}  gross_exp=${(grossExp * 100).toFixed(4)}%/trade  costed_exp=${(costedExp * 100).toFixed(4)}%/trade ${costedExp > 0 ? "(clears costs)" : ""}`,
      );
      return {
        trade_count: gross.trade_count, win_rate: gross.win_rate, avg_win_pct: gross.avg_win_pct,
        avg_loss_pct: gross.avg_loss_pct, profit_factor: gross.profit_factor,
        gross_expectancy_pct_per_trade: grossExp, costed_expectancy_pct_per_trade: costedExp,
      };
    }

    const rResult = {};
    console.log("\n-- 1. Baseline (all events) --");
    rResult.baseline = reportBucket("all", trades);

    console.log("\n-- 2. Multi-TF confirm-count (§21/#38) --");
    rResult.confirmCount = {};
    for (const bucket of ["0", "1", "2", "3+"]) {
      const bt = trades.filter((t) => (t.confirmCount >= 3 ? "3+" : String(t.confirmCount)) === bucket);
      rResult.confirmCount[bucket] = reportBucket(`confirmCount=${bucket}`, bt);
    }

    console.log("\n-- 3. wt2 extremity bucket (§27/#44) --");
    rResult.extremity = {};
    for (const bucket of ["53-70", "70-80", "80-100", "100+"]) {
      const bt = trades.filter((t) => t.extremityBucket === bucket);
      rResult.extremity[bucket] = reportBucket(bucket, bt);
    }

    console.log("\n-- 4. Recent same-side divergence confluence (§28/#45) --");
    rResult.divConfluence = {
      not_confluent: reportBucket("not confluent", trades.filter((t) => !t.divConfluent)),
      confluent: reportBucket("confluent", trades.filter((t) => t.divConfluent)),
    };

    console.log("\n-- 5. COMBINED: wt2 70-80 AND recent divergence (§28's leading candidate) --");
    const combined = trades.filter((t) => t.extremityBucket === "70-80" && t.divConfluent);
    const combinedRest = trades.filter((t) => !(t.extremityBucket === "70-80" && t.divConfluent));
    rResult.combinedBest = {
      combined: reportBucket("wt2 70-80 + divergence", combined),
      rest: reportBucket("everything else", combinedRest),
    };

    console.log("\n-- 6. Prior yellowCross within 10 bars (§22/#39 corrected) --");
    rResult.yellowXPrior = {
      no_prior: reportBucket("no prior yellowX", trades.filter((t) => !t.yellowXPrior)),
      prior: reportBucket("prior yellowX", trades.filter((t) => t.yellowXPrior)),
    };

    allResults[`${rMult}R`] = { ...rResult, inconclusive, total_resolved: trades.length };
  }

  console.log("\n=== Capacity: trade frequency (1R construction, same entries at every R) ===");
  const spanSeconds = candles[n - 1].t - candles[0].t;
  const spanYears = spanSeconds / (365.25 * 86400);
  console.log(`  data span: ${spanYears.toFixed(2)} years`);
  console.log(`  all events: ${labeled.length} (${(labeled.length / spanYears).toFixed(1)}/yr)`);
  const combinedAll = labeled.filter((e) => e.extremityBucket === "70-80" && e.divConfluent);
  console.log(`  wt2 70-80 + divergence-confluent: ${combinedAll.length} (${(combinedAll.length / spanYears).toFixed(1)}/yr)`);
  const threePlus = labeled.filter((e) => (e.confirmCount >= 3));
  console.log(`  confirmCount 3+: ${threePlus.length} (${(threePlus.length / spanYears).toFixed(1)}/yr)`);

  const result = {
    trade_construction: `entry = next-bar-open after the signal bar; risk R = ${ATR_MULT}x ATR(${ATR_LEN}) at the signal bar; stop = entry -/+ R; target = entry +/- R-multiple x R; race-to-target-or-stop, max ${MAX_HOLD_BARS} bars, same-bar ambiguity scored as the stop`,
    r_multiples_tested: R_MULTIPLES,
    data_span_years: spanYears,
    results: allResults,
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `cost_capacity_backtest_${result.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

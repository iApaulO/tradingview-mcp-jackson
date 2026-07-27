#!/usr/bin/env node
// Cost/capacity test on the breakout-direction-vs-SMC-bias finding (ARCHITECTURE.md §11 follow-up:
// 79.8% alignment, swing scope, p=0.0000, checked for same-bar leakage and it holds at real lag).
// That finding is a CLASSIFICATION -- agreement between two already-known facts at break time --
// not a strategy. This builds the natural trade implied by it: when a divergence zone breaks,
// take a continuation trade in the breakout direction, and test whether alignment with SMC's
// prevailing bias (the exact condition the significance test measured) actually predicts better
// P&L on that trade, at real cost.
//
// No natural "next event" boundary exists for this trade the way touch-end existed for the
// hold/break classification -- this is a fresh entry AFTER a break completes, so it needs its own
// exit rule. Reuses the exact fixed-R:R convention already established for Divergence-for-Many
// (confluence-backtest-fixed-rr.js): risk R = 0.6x ATR(14) at zone creation (the same constant
// calc.js uses for zone dedup, not an invented number), target = entry +/- R-multiple x R,
// race-to-target-or-stop, R in {1, 1.5, 2, 3}. Entry = next-bar-open after the touch that broke
// the zone ENDS (when the break is actually confirmed/known) -- not touch start, since "which
// direction did this break go" isn't knowable until the interaction resolves.
//
// SMC bias source: scope='swing' only (the primary, cleaner-performing scope from the
// significance test -- internal scope was secondary/noisier there and is not re-tested here).
//
// Usage: node scripts/signal-bus/cross-confluence/breakout-bias-backtest.js [--r=1,1.5,2,3]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const DIV_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const ATR_MULT = 0.6;
const MAX_HOLD_BARS = 200;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function biasAt(events, t) {
  if (!events || events.length === 0) return null;
  let lo = 0, hi = events.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans === -1 ? null : events[ans].side;
}

function loadBrokenTouchesWithBias() {
  const dbDiv = new DatabaseSync(DIV_DB_PATH, { readOnly: true });
  const rows = dbDiv.prepare(
    `SELECT t.id as touch_id, t.start_time, t.end_bar_idx, t.end_time,
            z.timeframe, z.side as zone_side, z.atr_at_creation
     FROM touches t JOIN zones z ON z.id = t.zone_id
     WHERE t.outcome = 'broken' AND t.ongoing = 0`,
  ).all();
  dbDiv.close();

  const dbSmc = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const structRows = dbSmc.prepare(`SELECT timeframe, side, time FROM structure_events WHERE scope = 'swing' ORDER BY timeframe, time`).all();
  dbSmc.close();
  const byTf = new Map();
  for (const r of structRows) { if (!byTf.has(r.timeframe)) byTf.set(r.timeframe, []); byTf.get(r.timeframe).push(r); }

  const out = [];
  for (const r of rows) {
    const breakoutDirection = r.zone_side === "bullish" ? "bearish" : "bullish";
    const bias = biasAt(byTf.get(r.timeframe), r.start_time); // bias AS OF touch start -- matches the significance test exactly
    if (bias == null) continue;
    if (r.atr_at_creation == null || r.atr_at_creation <= 0) continue;
    out.push({
      timeframe: r.timeframe,
      entryBarIdx: r.end_bar_idx + 1,
      side: breakoutDirection === "bullish" ? "long" : "short",
      atrAtCreation: r.atr_at_creation,
      aligned: bias === breakoutDirection ? "aligned" : "not-aligned",
    });
  }
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

async function main() {
  const entries = loadBrokenTouchesWithBias();
  console.log(`${entries.length} broken touches with a defined swing-scope SMC bias reading (entry = next-bar-open after the break completes).\n`);

  const entriesByTf = new Map();
  for (const e of entries) { if (!entriesByTf.has(e.timeframe)) entriesByTf.set(e.timeframe, []); entriesByTf.get(e.timeframe).push(e); }

  const confirmedParams = { takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const allResults = {};

  for (const rMult of R_MULTIPLES) {
    console.log(`=== R-multiple target: ${rMult}R (risk = ${ATR_MULT}x ATR(14) at zone creation) ===`);
    const buckets = { aligned: [], "not-aligned": [] };
    let inconclusive = 0;

    for (const [tf, tfEntries] of entriesByTf) {
      const candles = await loadCandles(tf);
      for (const e of tfEntries) {
        if (e.entryBarIdx >= candles.length) continue;
        const entryPrice = candles[e.entryBarIdx].o;
        const entryTime = candles[e.entryBarIdx].t;
        const risk = ATR_MULT * e.atrAtCreation;
        const stopPrice = e.side === "long" ? entryPrice - risk : entryPrice + risk;
        const targetPrice = e.side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;
        const result = simulateFixedR(candles, e.entryBarIdx, e.side, stopPrice, targetPrice);
        if (!result) { inconclusive++; continue; }
        const pnlPct = e.side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
        buckets[e.aligned].push({ side: e.side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, timeframe: tf });
      }
    }

    const rResult = {};
    for (const [name, bucketTrades] of Object.entries(buckets)) {
      const costedTrades = applyCosts(bucketTrades, confirmedParams);
      const gross = computeMetrics(bucketTrades);
      const costed = computeMetrics(costedTrades);
      // computeMetrics' net_return_pct/final_equity_multiple assume full-equity SEQUENTIAL
      // compounding -- nonsensical at this trade count/frequency since trades from different
      // timeframes genuinely overlap in time (thousands of concurrent positions can't be modeled
      // as one account reinvesting 100% into one trade at a time). Use the arithmetic-mean
      // per-trade expectancy instead -- invariant to trade ordering/overlap, the correct
      // non-compounding way to ask "does the average trade clear costs."
      const grossExpectancy = bucketTrades.reduce((s, t) => s + t.pnlPct, 0) / bucketTrades.length;
      const costedExpectancy = costedTrades.reduce((s, t) => s + t.pnlPct, 0) / costedTrades.length;
      console.log(
        `  ${name.padEnd(14)} n=${gross.trade_count}  win_rate=${(gross.win_rate * 100).toFixed(1)}%  PF=${gross.profit_factor?.toFixed(2)}  avg_win=${(gross.avg_win_pct * 100).toFixed(3)}%  avg_loss=${(gross.avg_loss_pct * 100).toFixed(3)}%  expectancy_gross=${(grossExpectancy * 100).toFixed(4)}%/trade  expectancy_costed=${(costedExpectancy * 100).toFixed(4)}%/trade`,
      );
      rResult[name] = {
        trade_count: gross.trade_count,
        win_rate: gross.win_rate,
        avg_win_pct: gross.avg_win_pct,
        avg_loss_pct: gross.avg_loss_pct,
        profit_factor: gross.profit_factor,
        expectancy_pct_per_trade_gross: grossExpectancy,
        expectancy_pct_per_trade_costed: costedExpectancy,
        note: "net_return_pct/final_equity_multiple omitted -- full-equity compounding is invalid here since trades from different timeframes overlap in time; expectancy_pct_per_trade is the trustworthy figure",
      };
    }
    console.log(`  (${inconclusive} inconclusive within ${MAX_HOLD_BARS} bars -- excluded)\n`);
    allResults[`${rMult}R`] = { buckets: rResult, inconclusive };
  }

  console.log("=== Capacity: trade frequency per bucket (1R construction, same entries at every R) ===");
  const allEntryTimes = entries.map((e) => e); // just count -- span from touch times isn't loaded per-candle here, use rough span via first R result timestamps instead
  // Use the aligned/not-aligned counts from the 1R run for a frequency read (entry set is identical across R multiples)
  const firstR = Object.values(allResults)[0];
  for (const [name, b] of Object.entries(firstR.buckets)) {
    console.log(`  ${name.padEnd(14)} ${b.trade_count} trades`);
  }

  const result = {
    scope_used_for_bias: "swing",
    trade_construction: `entry = next-bar-open after the breaking touch ENDS (break confirmed, no look-ahead); side = breakout direction; risk R = ${ATR_MULT}x ATR(14) at zone creation; stop = entry -/+ R; target = entry +/- R-multiple x R; race-to-target-or-stop, max ${MAX_HOLD_BARS} bars, same-bar ambiguity scored as the stop`,
    r_multiples_tested: R_MULTIPLES,
    total_entries_with_defined_bias: entries.length,
    results: allResults,
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `breakout_bias_backtest_${result.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

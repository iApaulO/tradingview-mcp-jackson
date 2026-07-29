#!/usr/bin/env node
// Follow-up to recurrence-backtest.js, mirroring confluence-backtest-fixed-rr.js exactly: same
// stop (order block's own far boundary), but a genuine fixed R:R target instead of "wherever the
// zone happened to clear" -- tests whether the naive construction's size asymmetry (if any) is
// what's blocking the high-recurrence bucket, the same hypothesis already tested for confluence.
//
// Usage: node scripts/signal-bus/smc/recurrence-backtest-fixed-rr.js [--tf=4h] [--r=1,1.5,2,3]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const SINGLE_TF = args.tf || null;
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const MAX_HOLD_BARS = 200;

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function buildEntries(tfFilter) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const obRows = db.prepare(
    `SELECT id, timeframe, side, bar_high, bar_low, recurrence_count FROM order_blocks${tfFilter ? " WHERE timeframe = ?" : ""}`,
  ).all(...(tfFilter ? [tfFilter] : []));
  const touchRows = db.prepare(
    `SELECT order_block_id, start_bar_idx, outcome, ongoing FROM order_block_touches WHERE order_block_id IN (${obRows.map(() => "?").join(",") || "0"})`,
  ).all(...obRows.map((o) => o.id));
  db.close();

  const obById = new Map(obRows.map((o) => [o.id, o]));
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    if (!entriesByTf.has(ob.timeframe)) entriesByTf.set(ob.timeframe, []);
    entriesByTf.get(ob.timeframe).push({ startBarIdx: t.start_bar_idx, ob });
  }
  return entriesByTf;
}

function bucketOf(rc) {
  return rc >= 3 ? "high (3-6)" : rc === 2 ? "mid (2)" : "isolated (1)";
}

function expectancy(trades) {
  return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null;
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
  console.log(SINGLE_TF ? `Building entries for ${SINGLE_TF} only ...` : "Building entries across all timeframes (combined) ...");
  const entriesByTf = await buildEntries(SINGLE_TF);

  const confirmedParams = { takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const allResults = {};

  for (const rMult of R_MULTIPLES) {
    console.log(`\n=== R-multiple target: ${rMult}R (same stop as before, target = entry +/- ${rMult}x risk) ===`);
    const buckets = { "isolated (1)": [], "mid (2)": [], "high (3-6)": [] };
    let inconclusive = 0;

    for (const [tf, entries] of entriesByTf) {
      const candles = await loadCandles(tf);
      for (const e of entries) {
        const entryIdx = e.startBarIdx + 1;
        if (entryIdx >= candles.length) continue;
        const entryPrice = candles[entryIdx].o;
        const entryTime = candles[entryIdx].t;
        const side = e.ob.side === "bullish" ? "long" : "short";
        const stopPrice = e.ob.side === "bullish" ? e.ob.bar_low : e.ob.bar_high;
        const risk = Math.abs(entryPrice - stopPrice);
        if (risk <= 0) continue;
        const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;

        const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
        if (!result) { inconclusive++; continue; }
        const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
        buckets[bucketOf(e.ob.recurrence_count)].push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, resolvedAs: result.outcome });
      }
    }

    const rResult = {};
    for (const [name, bucketTrades] of Object.entries(buckets)) {
      const gross = computeMetrics(bucketTrades);
      const costedTrades = applyCosts(bucketTrades, confirmedParams);
      const costed = computeMetrics(costedTrades);
      console.log(
        `  ${name.padEnd(12)} n=${gross.trade_count}  win_rate=${(gross.win_rate * 100).toFixed(1)}%  gross_exp=${(expectancy(bucketTrades) * 100).toFixed(4)}%/trade  costed_exp=${(expectancy(costedTrades) * 100).toFixed(4)}%/trade  PF=${gross.profit_factor?.toFixed(2)}`,
      );
      rResult[name] = {
        trade_count: gross.trade_count,
        win_rate: gross.win_rate,
        avg_win_pct: gross.avg_win_pct,
        avg_loss_pct: gross.avg_loss_pct,
        gross_expectancy_pct_per_trade: expectancy(bucketTrades),
        costed_expectancy_pct_per_trade: expectancy(costedTrades),
        profit_factor: gross.profit_factor,
      };
    }
    console.log(`  (${inconclusive} entries inconclusive -- neither target nor stop hit within ${MAX_HOLD_BARS} bars, excluded)`);
    allResults[`${rMult}R`] = { buckets: rResult, inconclusive };
  }

  const result = {
    scope: SINGLE_TF || "all_timeframes_combined",
    trade_construction: "entry = next-bar-open after touch start; stop = order block's own far boundary (unchanged); target = entry +/- R-multiple x risk; first of stop/target hit wins, same-bar ambiguity scored conservatively as the stop -- identical to confluence-backtest-fixed-rr.js, bucketed by recurrence_count",
    r_multiples_tested: R_MULTIPLES,
    max_hold_bars: MAX_HOLD_BARS,
    results: allResults,
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `recurrence_backtest_fixed_rr_${SINGLE_TF || "combined"}_${result.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

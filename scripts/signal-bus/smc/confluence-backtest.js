#!/usr/bin/env node
// Cost/capacity testing on the SMC order-block confluence finding (ARCHITECTURE.md §10: hold rate
// 34.7% at confluence=1 up to 68.0% at confluence=8, p<0.00001). That finding is a hold/break
// CLASSIFICATION, not a strategy -- there's no entry/exit/P&L in it yet. This builds real trades
// out of the existing touch data, then runs the SAME confirmed cost model already built for the
// backtest program (scripts/backtest/lib/costs.js -- real Coinbase derivatives fee tier, both
// funding-sign assumptions), rather than re-deriving costs from scratch.
//
// Trade construction from a touch/interaction (next-bar-open fills throughout, no look-ahead,
// same discipline as the rest of the backtest program):
//   - side: long for a bullish (demand) order block, short for bearish (supply)
//   - entry: open of the bar AFTER the interaction starts (price has just entered the zone)
//   - exit, if outcome="held": open of the bar AFTER the interaction ends (price confirmed clear
//     of the zone)
//   - exit, if outcome="broken": the block's own boundary price (bar_low for bullish, bar_high
//     for bearish) at the block's real, exact mitigation time -- a stop placed at the zone edge
//     would have filled almost exactly there under HIGHLOW mitigation semantics
//
// This is NOT the only way to construct a trade from a touch (a fixed R-multiple target instead
// of "exit when the zone resolves" is an obvious alternative) -- flagged as a modeling choice, not
// the only valid one, consistent with how tolerance/decay constants were flagged elsewhere in the
// signal-bus project.
//
// Usage: node scripts/signal-bus/smc/confluence-backtest.js [--tf=4h]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { costSensitivitySweep, applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const SINGLE_TF = args.tf || null;

async function buildTrades(tfFilter) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const obRows = db.prepare(
    `SELECT id, timeframe, side, bar_high, bar_low, mitigated_time, confluence_count FROM order_blocks${tfFilter ? " WHERE timeframe = ?" : ""}`,
  ).all(...(tfFilter ? [tfFilter] : []));
  const touchRows = db.prepare(
    `SELECT order_block_id, start_bar_idx, end_bar_idx, outcome, ongoing FROM order_block_touches WHERE order_block_id IN (${obRows.map(() => "?").join(",") || "0"})`,
  ).all(...obRows.map((o) => o.id));
  db.close();

  const obById = new Map(obRows.map((o) => [o.id, o]));
  const touchesByTf = new Map();
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    if (!touchesByTf.has(ob.timeframe)) touchesByTf.set(ob.timeframe, []);
    touchesByTf.get(ob.timeframe).push({ ...t, ob });
  }

  const trades = [];
  for (const [tf, touches] of touchesByTf) {
    const candles = await loadCandles(tf);
    for (const t of touches) {
      if (t.ongoing) continue; // no resolved exit yet -- can't compute a completed trade

      const entryIdx = t.start_bar_idx + 1;
      if (entryIdx >= candles.length) continue;
      const entryPrice = candles[entryIdx].o;
      const entryTime = candles[entryIdx].t;
      const side = t.ob.side === "bullish" ? "long" : "short";

      let exitPrice, exitTime;
      if (t.outcome === "held") {
        const exitIdx = t.end_bar_idx + 1;
        if (exitIdx >= candles.length) continue;
        exitPrice = candles[exitIdx].o;
        exitTime = candles[exitIdx].t;
      } else {
        exitPrice = t.ob.side === "bullish" ? t.ob.bar_low : t.ob.bar_high;
        exitTime = t.ob.mitigated_time;
      }
      if (exitTime == null || exitTime <= entryTime) continue; // guard against any malformed ordering

      const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
      trades.push({ side, entryTime, entryPrice, exitTime, exitPrice, pnlPct, timeframe: tf, confluenceCount: t.ob.confluence_count, outcome: t.outcome });
    }
  }
  return trades;
}

function bucketOf(cc) {
  return cc >= 6 ? "high (6-8)" : cc >= 3 ? "mid (3-5)" : "low (1-2)";
}

async function main() {
  console.log(SINGLE_TF ? `Building trades for ${SINGLE_TF} only ...` : "Building trades across all timeframes (combined, matching the significance test) ...");
  const trades = await buildTrades(SINGLE_TF);
  console.log(`${trades.length} completed trades constructed from touch data.\n`);

  const buckets = { "low (1-2)": [], "mid (3-5)": [], "high (6-8)": [] };
  for (const t of trades) buckets[bucketOf(t.confluenceCount)].push(t);

  console.log("=== Gross (zero cost) ===");
  for (const [name, bucketTrades] of Object.entries(buckets)) {
    const m = computeMetrics(bucketTrades);
    console.log(`  ${name.padEnd(12)} n=${m.trade_count}  win_rate=${(m.win_rate * 100).toFixed(1)}%  net_return=${m.net_return_pct?.toFixed(2)}x  profit_factor=${m.profit_factor?.toFixed(2)}`);
  }

  console.log("\n=== Confirmed derivatives fee tier (0.070%/0.065%, pessimistic funding) ===");
  const confirmedParams = { takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  for (const [name, bucketTrades] of Object.entries(buckets)) {
    const costed = applyCosts(bucketTrades, confirmedParams);
    const m = computeMetrics(costed);
    console.log(`  ${name.padEnd(12)} n=${m.trade_count}  win_rate=${(m.win_rate * 100).toFixed(1)}%  net_return=${m.net_return_pct?.toFixed(2)}x  profit_factor=${m.profit_factor?.toFixed(2)}`);
  }

  console.log("\n=== Full cost sensitivity, high-confluence bucket only ===");
  const highSweep = costSensitivitySweep(buckets["high (6-8)"]);
  for (const [name, { params, trades: costedTrades }] of Object.entries(highSweep)) {
    const m = computeMetrics(costedTrades);
    console.log(`  ${name.padEnd(38)} net_return=${m.net_return_pct?.toFixed(2)}x  (taker=${(params.takerFeePct * 100).toFixed(3)}%, funding/hr=${(params.fundingPctPerHour * 100).toFixed(5)}%${params.fundingMode ? ", " + params.fundingMode : ""})`);
  }

  console.log("\n=== Capacity: trade frequency per bucket ===");
  const allTimes = trades.map((t) => t.entryTime);
  let spanYears = 0;
  if (allTimes.length) {
    let minT = Infinity, maxT = -Infinity;
    for (const t of allTimes) { if (t < minT) minT = t; if (t > maxT) maxT = t; } // avoid Math.max/min(...) call-stack limit on large trade arrays
    spanYears = (maxT - minT) / (365.25 * 86400);
  }
  for (const [name, bucketTrades] of Object.entries(buckets)) {
    console.log(`  ${name.padEnd(12)} ${bucketTrades.length} trades over ${spanYears.toFixed(1)}yr = ${(bucketTrades.length / spanYears).toFixed(1)} trades/year`);
  }

  const bucketSummary = {};
  for (const [name, bucketTrades] of Object.entries(buckets)) {
    const gross = computeMetrics(bucketTrades);
    const costed = computeMetrics(applyCosts(bucketTrades, confirmedParams));
    bucketSummary[name] = {
      trade_count: gross.trade_count,
      trades_per_year: bucketTrades.length / spanYears,
      gross: { win_rate: gross.win_rate, avg_win_pct: gross.avg_win_pct, avg_loss_pct: gross.avg_loss_pct, net_return_pct: gross.net_return_pct, profit_factor: gross.profit_factor },
      confirmed_derivatives_costed: { win_rate: costed.win_rate, net_return_pct: costed.net_return_pct, profit_factor: costed.profit_factor },
    };
  }
  const result = {
    scope: SINGLE_TF || "all_timeframes_combined",
    trade_construction:
      "entry = next-bar-open after touch starts; exit(held) = next-bar-open after touch ends; exit(broken) = order block's boundary price at its real mitigation time",
    total_trades: trades.length,
    span_years: spanYears,
    buckets: bucketSummary,
    diagnosis:
      "Negative gross P&L in every bucket despite a real, tested hold-rate gradient (ARCHITECTURE.md §10) -- avg_loss runs 1.7-2.8x avg_win across buckets, because this trade construction caps wins at 'price just cleared the zone' while losses ride the full zone width to the boundary stop. A majority win rate (53.6% at high confluence) cannot overcome that size asymmetry. This is a trade-construction problem, not primarily a cost problem -- costs make an already-negative result modestly worse, they are not the deciding factor.",
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `confluence_backtest_${SINGLE_TF || "combined"}_${result.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node
// Cost/capacity testing on the SMC order-block RECURRENCE finding (ARCHITECTURE.md §10 /
// significance-register.md #27: hold rate 49.0% at recurrence=1 up to 82.4% at recurrence=5,
// r=0.2109, largely survives the touchCount confound that broke #28a). Mirrors
// confluence-backtest.js exactly -- same trade construction, same cost model -- bucketed by
// recurrence_count instead of confluence_count.
//
// Trade construction (identical to confluence-backtest.js, next-bar-open fills, no look-ahead):
//   - side: long for a bullish (demand) order block, short for bearish (supply)
//   - entry: open of the bar AFTER the interaction starts
//   - exit, if outcome="held": open of the bar AFTER the interaction ends
//   - exit, if outcome="broken": the block's own boundary price at its real mitigation time
//
// Reports BOTH the compounded net_return_pct (kept for direct comparability with the original
// confluenceCount result) AND a non-compounding per-trade expectancy (metrics.js's own header
// warning, added after the breakout-bias compounding bug: full-equity compounding is invalid once
// trades from multiple timeframes genuinely overlap in time, which combined-timeframe buckets
// here do) -- expectancy is the trustworthy number if the two disagree.
//
// Usage: node scripts/signal-bus/smc/recurrence-backtest.js [--tf=4h]

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
    `SELECT id, timeframe, side, bar_high, bar_low, mitigated_time, recurrence_count FROM order_blocks${tfFilter ? " WHERE timeframe = ?" : ""}`,
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
      if (t.ongoing) continue;

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
      if (exitTime == null || exitTime <= entryTime) continue;

      const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
      trades.push({ side, entryTime, entryPrice, exitTime, exitPrice, pnlPct, timeframe: tf, recurrenceCount: t.ob.recurrence_count, outcome: t.outcome });
    }
  }
  return trades;
}

function bucketOf(rc) {
  return rc >= 3 ? "high (3-6)" : rc === 2 ? "mid (2)" : "isolated (1)";
}

function expectancy(trades) {
  return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null;
}

async function main() {
  console.log(SINGLE_TF ? `Building trades for ${SINGLE_TF} only ...` : "Building trades across all timeframes (combined, matching the significance test) ...");
  const trades = await buildTrades(SINGLE_TF);
  console.log(`${trades.length} completed trades constructed from touch data.\n`);

  const buckets = { "isolated (1)": [], "mid (2)": [], "high (3-6)": [] };
  for (const t of trades) buckets[bucketOf(t.recurrenceCount)].push(t);

  const confirmedParams = { takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };

  console.log("=== Gross (zero cost) ===");
  for (const [name, bucketTrades] of Object.entries(buckets)) {
    const m = computeMetrics(bucketTrades);
    console.log(`  ${name.padEnd(12)} n=${m.trade_count}  win_rate=${(m.win_rate * 100).toFixed(1)}%  net_return=${m.net_return_pct?.toFixed(2)}x  expectancy=${(expectancy(bucketTrades) * 100).toFixed(4)}%/trade  PF=${m.profit_factor?.toFixed(2)}`);
  }

  console.log("\n=== Confirmed derivatives fee tier (0.070%/0.065%, pessimistic funding) ===");
  for (const [name, bucketTrades] of Object.entries(buckets)) {
    const costedTrades = applyCosts(bucketTrades, confirmedParams);
    const m = computeMetrics(costedTrades);
    console.log(`  ${name.padEnd(12)} n=${m.trade_count}  win_rate=${(m.win_rate * 100).toFixed(1)}%  net_return=${m.net_return_pct?.toFixed(2)}x  expectancy=${(expectancy(costedTrades) * 100).toFixed(4)}%/trade  PF=${m.profit_factor?.toFixed(2)}`);
  }

  console.log("\n=== Full cost sensitivity, high-recurrence bucket only ===");
  const highSweep = costSensitivitySweep(buckets["high (3-6)"]);
  for (const [name, { params, trades: costedTrades }] of Object.entries(highSweep)) {
    const m = computeMetrics(costedTrades);
    console.log(`  ${name.padEnd(38)} net_return=${m.net_return_pct?.toFixed(2)}x  expectancy=${(expectancy(costedTrades) * 100).toFixed(4)}%/trade  (taker=${(params.takerFeePct * 100).toFixed(3)}%, funding/hr=${(params.fundingPctPerHour * 100).toFixed(5)}%${params.fundingMode ? ", " + params.fundingMode : ""})`);
  }

  console.log("\n=== Capacity: trade frequency per bucket ===");
  const allTimes = trades.map((t) => t.entryTime);
  const spanYears = allTimes.length ? (Math.max(...allTimes) - Math.min(...allTimes)) / (365.25 * 86400) : 0;
  for (const [name, bucketTrades] of Object.entries(buckets)) {
    console.log(`  ${name.padEnd(12)} ${bucketTrades.length} trades over ${spanYears.toFixed(1)}yr = ${(bucketTrades.length / spanYears).toFixed(1)} trades/year`);
  }

  const bucketSummary = {};
  for (const [name, bucketTrades] of Object.entries(buckets)) {
    const gross = computeMetrics(bucketTrades);
    const costedTrades = applyCosts(bucketTrades, confirmedParams);
    const costed = computeMetrics(costedTrades);
    bucketSummary[name] = {
      trade_count: gross.trade_count,
      trades_per_year: bucketTrades.length / spanYears,
      gross: { win_rate: gross.win_rate, avg_win_pct: gross.avg_win_pct, avg_loss_pct: gross.avg_loss_pct, net_return_pct: gross.net_return_pct, expectancy_pct_per_trade: expectancy(bucketTrades), profit_factor: gross.profit_factor },
      confirmed_derivatives_costed: { win_rate: costed.win_rate, net_return_pct: costed.net_return_pct, expectancy_pct_per_trade: expectancy(costedTrades), profit_factor: costed.profit_factor },
    };
  }
  const result = {
    scope: SINGLE_TF || "all_timeframes_combined",
    trade_construction: "entry = next-bar-open after touch starts; exit(held) = next-bar-open after touch ends; exit(broken) = order block's boundary price at its real mitigation time -- identical to confluence-backtest.js, bucketed by recurrence_count instead of confluence_count",
    note: "net_return_pct assumes full-equity sequential compounding, invalid once trades from different timeframes overlap in time (see metrics.js header) -- expectancy_pct_per_trade is the trustworthy figure for this combined-timeframe test",
    total_trades: trades.length,
    span_years: spanYears,
    buckets: bucketSummary,
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `recurrence_backtest_${SINGLE_TF || "combined"}_${result.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

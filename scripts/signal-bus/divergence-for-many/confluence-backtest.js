#!/usr/bin/env node
// Cost/capacity testing on the Divergence for Many confluence finding (ARCHITECTURE.md §9: hold
// rate 53.4% isolated -> 60.6% at 3-way confluence, p=0.0002/0.0001), mirroring exactly what
// scripts/signal-bus/smc/confluence-backtest.js did for SMC's order-block confluence finding.
// That finding is also a hold/break CLASSIFICATION, not a strategy -- no entry/exit/P&L existed.
//
// Trade construction differs from SMC's in one necessary way: these zones are LINES (a single
// price), not ranges/boxes, so there's no natural "far boundary" to use as an exact invalidation
// price the way an order block's own edge was. Both outcomes (held/broken) use the same uniform
// exit rule here -- next-bar-open after the touch/interaction ends, whatever that price turns out
// to be -- rather than inventing an artificial boundary price that doesn't exist in this
// indicator's own logic. Entry stays next-bar-open after the touch starts, same discipline as
// everywhere else in this project (no look-ahead).
//
// Usage: node scripts/signal-bus/divergence-for-many/confluence-backtest.js [--tf=4h]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { costSensitivitySweep, applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const SINGLE_TF = args.tf || null;

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function buildTrades(tfFilter) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const zoneRows = db.prepare(
    `SELECT id, timeframe, side, price, confluence_count FROM zones${tfFilter ? " WHERE timeframe = ?" : ""}`,
  ).all(...(tfFilter ? [tfFilter] : []));
  const touchRows = db.prepare(
    `SELECT zone_id, start_bar_idx, end_bar_idx, outcome, ongoing FROM touches WHERE zone_id IN (${zoneRows.map(() => "?").join(",") || "0"})`,
  ).all(...zoneRows.map((z) => z.id));
  db.close();

  const zoneById = new Map(zoneRows.map((z) => [z.id, z]));
  const touchesByTf = new Map();
  for (const t of touchRows) {
    const z = zoneById.get(t.zone_id);
    if (!touchesByTf.has(z.timeframe)) touchesByTf.set(z.timeframe, []);
    touchesByTf.get(z.timeframe).push({ ...t, zone: z });
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
      const side = t.zone.side === "bullish" ? "long" : "short";

      const exitIdx = t.end_bar_idx + 1;
      if (exitIdx >= candles.length) continue;
      const exitPrice = candles[exitIdx].o;
      const exitTime = candles[exitIdx].t;

      const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
      trades.push({ side, entryTime, entryPrice, exitTime, exitPrice, pnlPct, timeframe: tf, confluenceCount: t.zone.confluence_count, outcome: t.outcome });
    }
  }
  return trades;
}

function bucketOf(cc) {
  return cc >= 4 ? "4+ (top)" : cc === 3 ? "3" : cc === 2 ? "2" : "1 (isolated)";
}

async function main() {
  console.log(SINGLE_TF ? `Building trades for ${SINGLE_TF} only ...` : "Building trades across all timeframes (combined, matching the significance test) ...");
  const trades = await buildTrades(SINGLE_TF);
  console.log(`${trades.length} completed trades constructed from touch data.\n`);

  const buckets = { "1 (isolated)": [], "2": [], "3": [], "4+ (top)": [] };
  for (const t of trades) buckets[bucketOf(t.confluenceCount)].push(t);

  console.log("=== Gross (zero cost) ===");
  for (const [name, bucketTrades] of Object.entries(buckets)) {
    const m = computeMetrics(bucketTrades);
    console.log(`  ${name.padEnd(14)} n=${m.trade_count}  win_rate=${(m.win_rate * 100).toFixed(1)}%  net_return=${m.net_return_pct?.toFixed(2)}x  profit_factor=${m.profit_factor?.toFixed(2)}`);
  }

  console.log("\n=== Confirmed derivatives fee tier (0.070%/0.065%, pessimistic funding) ===");
  const confirmedParams = { takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  for (const [name, bucketTrades] of Object.entries(buckets)) {
    const costed = applyCosts(bucketTrades, confirmedParams);
    const m = computeMetrics(costed);
    console.log(`  ${name.padEnd(14)} n=${m.trade_count}  win_rate=${(m.win_rate * 100).toFixed(1)}%  net_return=${m.net_return_pct?.toFixed(2)}x  profit_factor=${m.profit_factor?.toFixed(2)}`);
  }

  console.log("\n=== Full cost sensitivity, top-confluence bucket only ===");
  const topSweep = costSensitivitySweep(buckets["4+ (top)"]);
  for (const [name, { params, trades: costedTrades }] of Object.entries(topSweep)) {
    const m = computeMetrics(costedTrades);
    console.log(`  ${name.padEnd(38)} net_return=${m.net_return_pct?.toFixed(2)}x  (taker=${(params.takerFeePct * 100).toFixed(3)}%, funding/hr=${(params.fundingPctPerHour * 100).toFixed(5)}%${params.fundingMode ? ", " + params.fundingMode : ""})`);
  }

  console.log("\n=== Capacity: trade frequency per bucket ===");
  const allTimes = trades.map((t) => t.entryTime);
  const spanYears = allTimes.length ? (Math.max(...allTimes) - Math.min(...allTimes)) / (365.25 * 86400) : 0;
  for (const [name, bucketTrades] of Object.entries(buckets)) {
    console.log(`  ${name.padEnd(14)} ${bucketTrades.length} trades over ${spanYears.toFixed(1)}yr = ${(bucketTrades.length / spanYears).toFixed(1)} trades/year`);
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
    trade_construction: "entry = next-bar-open after touch starts; exit (both held and broken) = next-bar-open after touch ends -- no boundary-price special-case, unlike SMC's order blocks, since these zones are lines with no natural far edge",
    total_trades: trades.length,
    span_years: spanYears,
    buckets: bucketSummary,
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

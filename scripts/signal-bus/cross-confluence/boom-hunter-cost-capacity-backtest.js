#!/usr/bin/env node
// Cost/capacity test for this session's outstanding Boom Hunter findings -- #60 (full-sequence),
// #60a (enter4 tier), #61 (nested cascade + recurrence boost) -- all previously only
// descriptive-significant, never checked against real trading costs. Same two-stage bar #27b/#49/#68
// require: real statistical significance already established (see those register rows), this file
// checks the second stage.
//
// Reuses the ALREADY-PERSISTED classification on smc.db's order_blocks (boom_full_sequence,
// boom_long_tier, boom_nested_depth, boom_nested_boost -- written by build-boom-confluence.js) --
// no rejoining from scratch. Real trades (not aggregated win/loss): entry = order_block_touches'
// start_bar_idx+1 open (same as every SMC/Boom Hunter significance test this session), stop = OB's
// own far edge, target = R-multiple of risk, race-to-target-or-stop max 200 bars. Real costs from
// costs.js's confirmed_derivatives tier + representative funding, same convention as #27b/#49/#68.
//
// Usage: node scripts/signal-bus/cross-confluence/boom-hunter-cost-capacity-backtest.js [--r=1,1.5,2,3]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const MAX_HOLD_BARS = 200;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const FEE_TIER = args["fee-tier"] || "confirmed_derivatives";

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }

function simulateFixedR(candles, entryIdx, stopPrice, targetPrice) {
  const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= endCheck; j++) {
    const bar = candles[j];
    if (bar.l <= stopPrice) return { exitPrice: stopPrice, exitTime: bar.t, outcome: "stop" };
    if (bar.h >= targetPrice) return { exitPrice: targetPrice, exitTime: bar.t, outcome: "target" };
  }
  return null;
}

async function buildTrades(rMultiple, candlesByTf) {
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const obRows = smcDb.prepare(
    "SELECT id, timeframe, bar_high, bar_low, recurrence_count, boom_long_tier, boom_full_sequence, boom_nested_depth, boom_nested_boost " +
    "FROM order_blocks WHERE side = 'bullish'",
  ).all();
  const touchRows = smcDb.prepare("SELECT order_block_id, start_bar_idx FROM order_block_touches").all();
  smcDb.close();

  const obById = new Map(obRows.map((o) => [o.id, o]));
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    if (!ob) continue;
    if (!entriesByTf.has(ob.timeframe)) entriesByTf.set(ob.timeframe, []);
    entriesByTf.get(ob.timeframe).push({ startBarIdx: t.start_bar_idx, ob });
  }

  const trades = [];
  for (const [tf, entries] of entriesByTf) {
    const candles = candlesByTf[tf];
    for (const e of entries) {
      const entryIdx = e.startBarIdx + 1;
      if (entryIdx >= candles.length) continue;
      const entryPrice = candles[entryIdx].o;
      const entryTime = candles[entryIdx].t;
      const stopPrice = e.ob.bar_low;
      const risk = entryPrice - stopPrice;
      if (risk <= 0) continue;
      const targetPrice = entryPrice + rMultiple * risk;
      const result = simulateFixedR(candles, entryIdx, stopPrice, targetPrice);
      if (!result) continue;
      const pnlPct = (result.exitPrice - entryPrice) / entryPrice;
      trades.push({
        side: "long", entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct,
        timeframe: tf, tier: e.ob.boom_long_tier, fullSequence: !!e.ob.boom_full_sequence,
        nestedBoost: !!e.ob.boom_nested_boost, recurrenceCount: e.ob.recurrence_count,
      });
    }
  }
  return trades;
}

function reportBucket(label, bucketTrades, confirmedParams) {
  if (bucketTrades.length < 30) { console.log(`  ${label.padEnd(32)} n=${bucketTrades.length} (too thin, <30)`); return null; }
  const gross = computeMetrics(bucketTrades);
  const costedTrades = applyCosts(bucketTrades, confirmedParams);
  const grossExp = expectancy(bucketTrades), costedExp = expectancy(costedTrades);
  console.log(
    `  ${label.padEnd(32)} n=${String(gross.trade_count).padEnd(6)} win=${(gross.win_rate * 100).toFixed(1)}% PF=${gross.profit_factor?.toFixed(2)} ` +
    `gross_exp=${(grossExp * 100).toFixed(4)}%/trade costed_exp=${(costedExp * 100).toFixed(4)}%/trade ${costedExp > 0 ? "(CLEARS COSTS)" : ""}`,
  );
  return { trade_count: gross.trade_count, win_rate: gross.win_rate, profit_factor: gross.profit_factor, gross_expectancy_pct_per_trade: grossExp, costed_expectancy_pct_per_trade: costedExp };
}

async function main() {
  const candlesByTf = {};
  for (const tf of LADDER_KEYS) candlesByTf[tf] = await loadCandles(tf);

  const confirmedParams = { takerFeePct: FEE_TIERS[FEE_TIER].takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  console.log(`Fee tier: ${FEE_TIER} (taker=${(FEE_TIERS[FEE_TIER].takerFeePct * 100).toFixed(3)}%, round-trip=${(FEE_TIERS[FEE_TIER].takerFeePct * 200).toFixed(3)}%)`);
  const allResults = {};

  for (const rMult of R_MULTIPLES) {
    console.log(`\n========== ${rMult}R ==========`);
    const trades = await buildTrades(rMult, candlesByTf);
    console.log(`${trades.length} resolved trades total\n`);

    console.log(`-- #60: full-sequence (any tier) vs not --`);
    const r60 = {
      full_sequence: reportBucket("full-sequence", trades.filter((t) => t.fullSequence), confirmedParams),
      not_full_sequence: reportBucket("not full-sequence", trades.filter((t) => !t.fullSequence), confirmedParams),
    };

    console.log(`\n-- #60: full-sequence by tier --`);
    const r60Tiers = {};
    for (const tier of ["lime", "blue", "yellow", "gray", "enter4"]) {
      r60Tiers[tier] = reportBucket(`tier=${tier}`, trades.filter((t) => t.fullSequence && t.tier === tier), confirmedParams);
    }

    console.log(`\n-- #61: nested_boost (nested AND recurrence>=2) vs not, WITHIN full-sequence --`);
    const fullSeqTrades = trades.filter((t) => t.fullSequence);
    const r61 = {
      nested_boost: reportBucket("nested_boost", fullSeqTrades.filter((t) => t.nestedBoost), confirmedParams),
      not_nested_boost: reportBucket("not nested_boost", fullSeqTrades.filter((t) => !t.nestedBoost), confirmedParams),
    };

    allResults[`${rMult}R`] = { tradeCount: trades.length, fullSequence: r60, byTier: r60Tiers, nestedBoost: r61 };
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results: allResults, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `boom_hunter_cost_capacity_backtest_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

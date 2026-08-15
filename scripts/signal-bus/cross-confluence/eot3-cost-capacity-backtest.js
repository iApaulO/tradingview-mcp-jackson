#!/usr/bin/env node
// Cost/capacity test on #66/#67 (EOT3 q5 down-episode, no-flag vs with-flag) -- previously only
// descriptive forward-return (mean-return/up-fraction), never a real trade construction. No natural
// OB-anchored stop exists for a raw oscillator episode, so this uses the house's own established
// convention for that situation (divergence-cost-capacity-backtest.js / nested-mtf-divergence-
// validation.js): entry = next-bar-open after the episode's start bar, risk = 0.6x ATR(14) Wilder
// at that bar, stop/target fixed-R, race-to-target-or-stop max 200 bars. Long-only (the episode's
// own "recovery back above 50" direction is what #66/#67 tested). Real costs from costs.js
// confirmed_derivatives tier + representative funding, matching #27b/#49/#68/#69's bar.
//
// Usage: node scripts/signal-bus/cross-confluence/eot3-cost-capacity-backtest.js [--r=1,1.5,2,3]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const BOOM_DB_PATH = new URL("../../../data/signal-bus/boom-hunter.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const ATR_LEN = 14;
const ATR_MULT = 0.6;
const MAX_HOLD_BARS = 200;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const FEE_TIER = args["fee-tier"] || "confirmed_derivatives";

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
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
function simulateFixedR(candles, entryIdx, stopPrice, targetPrice) {
  const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= endCheck; j++) {
    const bar = candles[j];
    if (bar.l <= stopPrice) return { exitPrice: stopPrice, exitTime: bar.t, outcome: "stop" };
    if (bar.h >= targetPrice) return { exitPrice: targetPrice, exitTime: bar.t, outcome: "target" };
  }
  return null;
}
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }

function reportBucket(label, bucketTrades, confirmedParams) {
  if (bucketTrades.length < 30) { console.log(`  ${label.padEnd(20)} n=${bucketTrades.length} (too thin, <30)`); return null; }
  const gross = computeMetrics(bucketTrades);
  const costedTrades = applyCosts(bucketTrades, confirmedParams);
  const grossExp = expectancy(bucketTrades), costedExp = expectancy(costedTrades);
  console.log(
    `  ${label.padEnd(20)} n=${String(gross.trade_count).padEnd(6)} win=${(gross.win_rate * 100).toFixed(1)}% PF=${gross.profit_factor?.toFixed(2)} ` +
    `gross_exp=${(grossExp * 100).toFixed(4)}%/trade costed_exp=${(costedExp * 100).toFixed(4)}%/trade ${costedExp > 0 ? "(CLEARS COSTS)" : ""}`,
  );
  return { trade_count: gross.trade_count, win_rate: gross.win_rate, profit_factor: gross.profit_factor, gross_expectancy_pct_per_trade: grossExp, costed_expectancy_pct_per_trade: costedExp };
}

async function buildTrades(rMultiple, candlesByTf, atrByTf) {
  const boomDb = new DatabaseSync(BOOM_DB_PATH, { readOnly: true });
  const trades = [];
  for (const tf of LADDER_KEYS) {
    const rows = boomDb.prepare("SELECT start_bar_idx, has_flag FROM eot3_episodes WHERE timeframe = ?").all(tf);
    const candles = candlesByTf[tf], atr14 = atrByTf[tf];
    for (const r of rows) {
      const entryIdx = r.start_bar_idx + 1;
      if (entryIdx >= candles.length) continue;
      const atrAtSignal = atr14[r.start_bar_idx];
      if (!Number.isFinite(atrAtSignal) || atrAtSignal <= 0) continue;
      const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
      const risk = ATR_MULT * atrAtSignal;
      const stopPrice = entryPrice - risk, targetPrice = entryPrice + rMultiple * risk;
      const result = simulateFixedR(candles, entryIdx, stopPrice, targetPrice);
      if (!result) continue;
      const pnlPct = (result.exitPrice - entryPrice) / entryPrice;
      trades.push({ side: "long", entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, hasFlag: !!r.has_flag });
    }
  }
  boomDb.close();
  return trades;
}

async function main() {
  const candlesByTf = {}, atrByTf = {};
  for (const tf of LADDER_KEYS) { candlesByTf[tf] = await loadCandles(tf); atrByTf[tf] = atr(candlesByTf[tf], ATR_LEN); }

  const confirmedParams = { takerFeePct: FEE_TIERS[FEE_TIER].takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  console.log(`Fee tier: ${FEE_TIER} (taker=${(FEE_TIERS[FEE_TIER].takerFeePct * 100).toFixed(3)}%, round-trip=${(FEE_TIERS[FEE_TIER].takerFeePct * 200).toFixed(3)}%)`);
  const allResults = {};

  for (const rMult of R_MULTIPLES) {
    console.log(`\n========== ${rMult}R ==========`);
    const trades = await buildTrades(rMult, candlesByTf, atrByTf);
    console.log(`${trades.length} resolved trades (0.6xATR14 risk, long-only entry after q5 bottom-crossing)`);
    allResults[`${rMult}R`] = {
      no_flag: reportBucket("no-flag episode", trades.filter((t) => !t.hasFlag), confirmedParams),
      with_flag: reportBucket("with-flag episode", trades.filter((t) => t.hasFlag), confirmedParams),
      all: reportBucket("all episodes", trades, confirmedParams),
    };
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results: allResults, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `eot3_cost_capacity_backtest_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

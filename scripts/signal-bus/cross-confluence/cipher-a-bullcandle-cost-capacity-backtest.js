#!/usr/bin/env node
// Cost/capacity test on #71 (Cipher A bullCandle nested confirmation) -- same two-stage bar as
// every other claimed-real finding in this register. Same 0.6xATR(14) fixed-R construction as the
// significance test, real costs from costs.js confirmed_derivatives tier + representative funding.
//
// Usage: node scripts/signal-bus/cross-confluence/cipher-a-bullcandle-cost-capacity-backtest.js [--r=1,1.5,2,3]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const CIPHER_A_DB_PATH = new URL("../../../data/signal-bus/cipher-a.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const ATR_LEN = 14;
const ATR_MULT = 0.6;
const MAX_HOLD_BARS = 200;
const NESTED_WINDOW_BARS = 10;
const PRICE_TOLERANCE_PCT = 0.01;

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
    if (bar.l <= stopPrice) return { exitPrice: stopPrice, exitTime: bar.t };
    if (bar.h >= targetPrice) return { exitPrice: targetPrice, exitTime: bar.t };
  }
  return null;
}
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }

// Returns cascade DEPTH (how many slower timeframes agree), not just a boolean -- the significance
// test (#71) showed a real dose-response with depth=7 (n=1328) hitting 45.8%/40.0%, well above the
// pooled nested rate. Unblock attempt: does a DEEP-cascade-only bucket clear costs even though the
// full nested bucket doesn't -- same "additional real condition" pattern as boom_nested_boost.
function checkNesting(eventsByTf, ev, ownTimeframe) {
  const ownIdx = LADDER_KEYS.indexOf(ownTimeframe);
  const slowerTfs = LADDER_KEYS.slice(0, ownIdx);
  let depth = 0;
  for (const tf of slowerTfs) {
    const windowSec = NESTED_WINDOW_BARS * BAR_DURATION_SEC[tf];
    const candidates = eventsByTf.get(tf);
    const match = candidates.some((c) => {
      if (c.time > ev.time) return false;
      if (ev.time - c.time > windowSec) return false;
      const tol = c.price * PRICE_TOLERANCE_PCT;
      return ev.price - tol <= c.price && c.price <= ev.price + tol;
    });
    if (match) depth++;
  }
  return depth;
}

async function buildTrades(rMultiple, candlesByTf, atrByTf) {
  const db = new DatabaseSync(CIPHER_A_DB_PATH, { readOnly: true });
  const eventsByTf = new Map();
  for (const tf of LADDER_KEYS) eventsByTf.set(tf, db.prepare("SELECT bar_idx, time, price FROM events WHERE timeframe = ? AND type = 'bull_candle'").all(tf));
  db.close();

  const trades = [];
  for (const tf of LADDER_KEYS) {
    const events = eventsByTf.get(tf);
    const candles = candlesByTf[tf], atr14 = atrByTf[tf];
    for (const ev of events) {
      const entryIdx = ev.bar_idx + 1;
      if (entryIdx >= candles.length) continue;
      const atrAtSignal = atr14[ev.bar_idx];
      if (!Number.isFinite(atrAtSignal) || atrAtSignal <= 0) continue;
      const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
      const risk = ATR_MULT * atrAtSignal;
      const stopPrice = entryPrice - risk, targetPrice = entryPrice + rMultiple * risk;
      const result = simulateFixedR(candles, entryIdx, stopPrice, targetPrice);
      if (!result) continue;
      const pnlPct = (result.exitPrice - entryPrice) / entryPrice;
      const depth = checkNesting(eventsByTf, ev, tf);
      trades.push({ side: "long", entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, nested: depth > 0, depth, timeframe: tf });
    }
  }
  return trades;
}

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

async function main() {
  const candlesByTf = {}, atrByTf = {};
  for (const tf of LADDER_KEYS) { candlesByTf[tf] = await loadCandles(tf); atrByTf[tf] = atr(candlesByTf[tf], ATR_LEN); }

  const confirmedParams = { takerFeePct: FEE_TIERS[FEE_TIER].takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  console.log(`Fee tier: ${FEE_TIER} (taker=${(FEE_TIERS[FEE_TIER].takerFeePct * 100).toFixed(3)}%, round-trip=${(FEE_TIERS[FEE_TIER].takerFeePct * 200).toFixed(3)}%)`);
  const allResults = {};

  for (const rMult of R_MULTIPLES) {
    console.log(`\n========== ${rMult}R ==========`);
    const trades = await buildTrades(rMult, candlesByTf, atrByTf);
    console.log(`${trades.length} resolved trades`);
    const nested = trades.filter((t) => t.nested), solo = trades.filter((t) => !t.nested);
    console.log(`-- nested vs solo --`);
    const r71 = { nested: reportBucket("nested", nested, confirmedParams), solo: reportBucket("solo", solo, confirmedParams) };

    console.log(`-- nested, by timeframe (15m/5m -- the independently significant ones) --`);
    const r71ByTf = {};
    for (const tf of ["15m", "5m"]) r71ByTf[tf] = reportBucket(`nested, ${tf}`, nested.filter((t) => t.timeframe === tf), confirmedParams);

    // Unblock attempt: deep-cascade-only buckets (depth>=4, depth>=6) -- #71's significance test
    // showed depth=6/7 hitting 44.1%/45.8% (1R), well above the pooled nested rate (43.3%).
    console.log(`-- unblock attempt: deep cascade only --`);
    const r71ByDepth = {};
    for (const minDepth of [4, 6, 7]) {
      r71ByDepth[`depth>=${minDepth}`] = reportBucket(`depth>=${minDepth}`, trades.filter((t) => t.depth >= minDepth), confirmedParams);
    }

    allResults[`${rMult}R`] = { tradeCount: trades.length, nestedVsSolo: r71, nestedByTf: r71ByTf, byDepth: r71ByDepth };
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results: allResults, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `cipher_a_bullcandle_cost_capacity_backtest_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

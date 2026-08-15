#!/usr/bin/env node
// Cost/capacity test on #72 (SuperTrend flip nested confirmation) -- the strongest significance
// result of this session's build-out, previously only descriptive. Same two-stage bar #27b/#49/#68/
// #69 require. Real trades (side-aware, long on bullish flip / short on bearish), same 0.6xATR(14)
// fixed-R construction as the significance test, real costs from costs.js confirmed_derivatives
// tier + representative funding.
//
// Usage: node scripts/signal-bus/cross-confluence/supertrend-nested-cost-capacity-backtest.js [--r=1,1.5,2,3]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ST_DB_PATH = new URL("../../../data/signal-bus/adaptive-supertrend.db", import.meta.url);
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
function simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice) {
  const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= endCheck; j++) {
    const bar = candles[j];
    const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
    const hitTarget = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
    if (hitStop) return { exitPrice: stopPrice, exitTime: bar.t };
    if (hitTarget) return { exitPrice: targetPrice, exitTime: bar.t };
  }
  return null;
}
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }

function checkNesting(eventsByTf, ev, ownTimeframe) {
  const ownIdx = LADDER_KEYS.indexOf(ownTimeframe);
  const slowerTfs = LADDER_KEYS.slice(0, ownIdx);
  for (const tf of slowerTfs) {
    const windowSec = NESTED_WINDOW_BARS * BAR_DURATION_SEC[tf];
    const candidates = eventsByTf.get(tf).filter((c) => c.direction === ev.direction);
    const match = candidates.some((c) => {
      if (c.time > ev.time) return false;
      if (ev.time - c.time > windowSec) return false;
      const tol = c.price * PRICE_TOLERANCE_PCT;
      return ev.price - tol <= c.price && c.price <= ev.price + tol;
    });
    if (match) return true;
  }
  return false;
}

async function buildTrades(rMultiple, candlesByTf, atrByTf) {
  const db = new DatabaseSync(ST_DB_PATH, { readOnly: true });
  const eventsByTf = new Map();
  for (const tf of LADDER_KEYS) eventsByTf.set(tf, db.prepare("SELECT bar_idx, time, price, direction, volatility_regime FROM events WHERE timeframe = ?").all(tf));
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
      const side = ev.direction === "bullish" ? "long" : "short";
      const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
      const risk = ATR_MULT * atrAtSignal;
      const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
      const targetPrice = side === "long" ? entryPrice + rMultiple * risk : entryPrice - rMultiple * risk;
      const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
      if (!result) continue;
      const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
      const nested = checkNesting(eventsByTf, ev, tf);
      trades.push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, nested, timeframe: tf, volatilityRegime: ev.volatility_regime });
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
    const r72 = { nested: reportBucket("nested", nested, confirmedParams), solo: reportBucket("solo", solo, confirmedParams) };

    // Per-timeframe within nested, for the largest independently-significant samples (5m/15m/1h/3h).
    console.log(`-- nested, by timeframe (5m/15m/1h/3h -- the independently significant ones) --`);
    const r72ByTf = {};
    for (const tf of ["3h", "1h", "15m", "5m"]) {
      r72ByTf[tf] = reportBucket(`nested, ${tf}`, nested.filter((t) => t.timeframe === tf), confirmedParams);
    }

    // Attempt to unblock: does volatility regime (K-means cluster, already computed/stored,
    // unused until now) concentrate the edge the way recurrence_count did for Boom Hunter's
    // nested_boost? Same "AND an additional real condition" pattern, not invented fresh.
    console.log(`-- nested, by volatility regime (unblock attempt) --`);
    const r72ByRegime = {};
    for (const regime of ["HIGH", "MEDIUM", "LOW"]) {
      r72ByRegime[regime] = reportBucket(`nested, ${regime}`, nested.filter((t) => t.volatilityRegime === regime), confirmedParams);
    }

    allResults[`${rMult}R`] = { tradeCount: trades.length, nestedVsSolo: r72, nestedByTf: r72ByTf, nestedByRegime: r72ByRegime };
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results: allResults, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `supertrend_nested_cost_capacity_backtest_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

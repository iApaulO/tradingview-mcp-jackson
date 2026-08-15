#!/usr/bin/env node
// Different construction attempt on #78's closest-to-clearing candidate (red_cross): every prior
// angle (nesting alone, wider fixed-R stop #79, cross-indicator confluence #80) used a FIXED R
// target that caps every winner at a pre-set multiple of risk. This tries a trailing ATR stop
// instead -- initial risk stays 0.6xATR(14) at the signal bar (unchanged, matching the house
// convention), but there is no fixed target: a chandelier stop trails the best close since entry
// by trailMult x (the same fixed signal-bar ATR), letting winners run instead of capping them.
// If the real-but-thin edge found in #77/#78 needs room to compound past the ~0.10% fee floor
// rather than a wider initial stop, this is the lever that tests it.
//
// Usage: node scripts/signal-bus/cross-confluence/cipher-a-signal-trailing-stop-cost-capacity-backtest.js --signal-type=red_cross [--trail-mult=1,1.5,2,3] [--fee-tier=bitunix_futures_vip1]

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
const INITIAL_ATR_MULT = 0.6;
const MAX_HOLD_BARS = 200;
const NESTED_WINDOW_BARS = 10;
const PRICE_TOLERANCE_PCT = 0.01;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const SIGNAL_TYPE = args["signal-type"];
if (!SIGNAL_TYPE) { console.error("Fatal: --signal-type is required"); process.exit(1); }
const TRAIL_MULTS = (args["trail-mult"] || "1,1.5,2,3").split(",").map(Number);
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

// Chandelier trailing stop: initial stop = entry -/+ 0.6xATR (unchanged risk). Once price moves
// favorably, the stop trails the best high/low since entry by trailMult x ATR (fixed, signal-bar
// ATR -- not recomputed bar-to-bar, matching this project's existing fixed-ATR-at-signal convention).
// Never loosens. No fixed target -- exits only on stop-out or MAX_HOLD_BARS (marked-to-close).
function simulateTrailing(candles, entryIdx, side, entryPrice, atrAtSignal, trailMult) {
  const initialStop = side === "long" ? entryPrice - INITIAL_ATR_MULT * atrAtSignal : entryPrice + INITIAL_ATR_MULT * atrAtSignal;
  let stop = initialStop;
  let bestExtreme = side === "long" ? candles[entryIdx].h : candles[entryIdx].l;
  const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= endCheck; j++) {
    const bar = candles[j];
    const hitStop = side === "long" ? bar.l <= stop : bar.h >= stop;
    if (hitStop) return { exitPrice: stop, exitTime: bar.t };
    if (side === "long") {
      bestExtreme = Math.max(bestExtreme, bar.h);
      stop = Math.max(stop, bestExtreme - trailMult * atrAtSignal);
    } else {
      bestExtreme = Math.min(bestExtreme, bar.l);
      stop = Math.min(stop, bestExtreme + trailMult * atrAtSignal);
    }
  }
  return { exitPrice: candles[endCheck].c, exitTime: candles[endCheck].t };
}
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }

function checkNesting(eventsByTf, ev, ownTimeframe) {
  const ownIdx = LADDER_KEYS.indexOf(ownTimeframe);
  const slowerTfs = LADDER_KEYS.slice(0, ownIdx);
  for (const tf of slowerTfs) {
    const windowSec = NESTED_WINDOW_BARS * BAR_DURATION_SEC[tf];
    const candidates = eventsByTf.get(tf).filter((c) => c.side === ev.side);
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

async function buildTrades(trailMult, candlesByTf, atrByTf) {
  const db = new DatabaseSync(CIPHER_A_DB_PATH, { readOnly: true });
  const eventsByTf = new Map();
  for (const tf of LADDER_KEYS) eventsByTf.set(tf, db.prepare("SELECT bar_idx, time, price, side FROM events WHERE timeframe = ? AND type = ?").all(tf, SIGNAL_TYPE));
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
      const side = ev.side === "bullish" ? "long" : "short";
      const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
      const result = simulateTrailing(candles, entryIdx, side, entryPrice, atrAtSignal, trailMult);
      const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
      const nested = checkNesting(eventsByTf, ev, tf);
      trades.push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, nested, timeframe: tf });
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
  console.log(`Signal: ${SIGNAL_TYPE}. Trailing ATR stop (initial=${INITIAL_ATR_MULT}x, no fixed target). Fee tier: ${FEE_TIER} (round-trip=${(FEE_TIERS[FEE_TIER].takerFeePct * 200).toFixed(3)}%)`);
  const allResults = {};

  for (const trailMult of TRAIL_MULTS) {
    console.log(`\n========== trail=${trailMult}x ATR ==========`);
    const trades = await buildTrades(trailMult, candlesByTf, atrByTf);
    console.log(`${trades.length} resolved trades`);
    const nested = trades.filter((t) => t.nested), solo = trades.filter((t) => !t.nested);
    const r = { nested: reportBucket("nested", nested, confirmedParams), solo: reportBucket("solo", solo, confirmedParams) };
    allResults[`trail_${trailMult}x`] = { tradeCount: trades.length, nestedVsSolo: r };
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { signalType: SIGNAL_TYPE, feeTier: FEE_TIER, results: allResults, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `cipher_a_${SIGNAL_TYPE}_trailing_stop_cost_capacity_backtest_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

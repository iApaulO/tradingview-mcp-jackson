#!/usr/bin/env node
// First combined-portfolio test in this project: runs the 4 findings that have EACH individually
// cleared both bars (real significance + real costs -- significance-register.md #27b, #49, #59/#68,
// #69/#75) SIMULTANEOUSLY on the same historical window, as one portfolio, instead of as 4 separate
// footnotes. Directly answers the gap flagged when iapaulo asked "what's left before this is a
// validated trading program": no one had checked whether these 4 double-count the same move,
// compound sensibly together, or how often they carry simultaneous BTC exposure.
//
// The 4 strategies, each reusing its own already-validated trade construction exactly:
//   A (#27b): SMC order-block recurrence_count>=3, all timeframes. Stop=OB far edge, fixed R target.
//   B (#49):  Cipher B regular divergence, 1d only, BEARISH side only (the validated leg).
//             Stop/target = 0.6xATR(14).
//   C (#68):  Cipher B regular divergence, 1h, nested 2+ of {15m,4h,1d} same-side confirmation.
//             Stop/target = 0.6xATR(14).
//   D (#69):  Boom Hunter full-sequence order blocks with nested_boost (nested cascade AND
//             recurrence>=2). Long-only (Boom Hunter's own house convention). Stop=OB far edge.
//
// All 4 costed with the SAME confirmed real fee tier (bitunix_futures_vip1, #75) for apples-to-
// apples comparison -- #27b/#49/#68's original register numbers used the pricier Coinbase tier, so
// this if anything understates how well they'd have cleared; #69 already used VIP1 fees natively.
//
// R multiple fixed at 2R by default: the one R-multiple where all 4 strategies independently clear
// costs in their own register rows (#27b: every R; #49: every R; #68: 1.5R/2R/3R; #69: every R at
// VIP1) -- a fair common point for combination, not cherry-picked for this test.
//
// Position sizing: fixed-fractional risk-per-trade (default 0.5% of current equity), applied to
// each trade's REALIZED R-multiple after costs (costedPnlPct / riskPct), compounded in chronological
// order by entry time. This assumes only one unit of the sizing fraction is ever at risk at a time --
// the overlap analysis below checks how often that assumption is actually violated by concurrent
// BTC exposure across strategies, rather than assuming it away.
//
// Usage: node scripts/signal-bus/cross-confluence/portfolio-backtest.js [--r=2] [--risk-pct=0.5]
//   [--fee-tier=bitunix_futures_vip1] [--max-portfolio-risk-pct=2] [--starting-bank=500]
//   [--sensitivity=5] [--min-mult=0.5] [--max-mult=2.5] [--premium-percentile=80] [--premium-reserve-pct=30]
//
// Runs TWO simulations per invocation: "flat" (#83's engine, every admitted trade sized identically)
// and "prioritized" (this extension, per iapaulo's direct request after #83: build a prioritization
// layer for when signals compete for scarce capital, with dynamic sizing "with the right
// confidence"). Prioritized sizing/admission is driven entirely by each strategy's OWN
// already-validated confidence gradient -- recurrence_count (#27), nConfirm (#59/#68),
// boom_nested_depth (#61/#69) -- not an invented score.

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeVmcCipherB, computeWtCrossSignals, computeRegularDivergenceUnion, computeWtExtremeFractals } from "../vmc-cipher-b/calc.js";
import { computeSwingPivotSeries } from "../smc/calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { classifyEngulfment } from "../smc/engulfment.js";

import { loadStructureEvents, buildCooccurrenceClusters } from "./lib/cooccurrence.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const D4M_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const MAX_HOLD_BARS = 200;
const ATR_LEN = 14;
const ATR_MULT = 0.6;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const R_MULT = Number(args.r || "2");
const RISK_PCT = Number(args["risk-pct"] || "0.5") / 100;
const FEE_TIER = args["fee-tier"] || "bitunix_futures_vip1";
// Position-sizing floor: a real account can't achieve unlimited leverage. Found by inspecting the
// raw data (not assumed) -- some SMC order blocks have a near-zero-width stop (smallest found:
// 0.00069% of price), which under fixed-fractional sizing implies >100x leverage and turns the
// fixed ~0.10% round-trip fee into a catastrophic per-trade R-multiple (~-145R) that the expectancy
// metrics used everywhere else in this project never surface (they're unweighted per-trade
// averages, where 174/13,559 degenerate OBs barely move the mean). An equity curve with realistic
// position sizing can't ignore this the way an expectancy average can -- sizing floors every
// trade's effective risk% at this minimum, capping implied leverage instead of silently blowing up.
const MIN_RISK_PCT = 0.001; // 0.1% of price, a realistic minimum practical stop distance
// Shared portfolio risk budget: the max fraction of equity allowed AT RISK across ALL
// concurrently-open positions from any strategy at once (not per-strategy). A new trade's desired
// risk (RISK_PCT) gets scaled down to whatever budget remains, or skipped entirely if the budget is
// already fully committed -- this is what a real account actually faces when 4 signal sources share
// one pool of margin on the same underlying, replacing the invalid "compound sequentially as if
// only one trade is ever open" assumption that broke the first two attempts.
const MAX_PORTFOLIO_RISK_PCT = Number(args["max-portfolio-risk-pct"] || "2") / 100;
const STARTING_BANK_USD = Number(args["starting-bank"] || "500");
// Dynamic sizing: risk% scales linearly with a trade's own empirically-fitted edge (mean costed
// %-RETURN within its own strategy's already-validated confidence gradient -- recurrence_count for
// A/#27, nConfirm for C/#59/#68, boom_nested_depth for D/#61/#69 -- not an invented score).
// SENSITIVITY controls how strongly; MIN/MAX_SIZE_MULT bound it so no single trade can dominate the
// budget. These are disclosed, chosen constants, not fitted/optimized against this same data.
// Default calibrated for %-return-scale edges (typically 0.0001-0.005): a ~0.3% edge (roughly
// A_recurrence's own range) maps to a multiplier around 1.5-2x, near-zero edge stays near 1x.
let SENSITIVITY = Number(args.sensitivity || "150"); // let, not const: the sensitivity-tuning test reassigns this per grid point
const MIN_SIZE_MULT = Number(args["min-mult"] || "0.5");
const MAX_SIZE_MULT = Number(args["max-mult"] || "2.5");
// Premium reservation: the top PREMIUM_PERCENTILE of positive-edge buckets get their own reserved
// slice of the total budget, so they can still get capital even when the general pool (used by
// every admitted trade) is saturated by higher-frequency, lower-edge flow.
const PREMIUM_PERCENTILE = Number(args["premium-percentile"] || "80") / 100;
const PREMIUM_RESERVE_PCT = Number(args["premium-reserve-pct"] || "30") / 100;
// Per-strategy floor (#96's fix): each strategy's own reserved slice of the budget, in equity-%
// terms, untouchable by any other strategy. Default 0.1% -- with 5 strategies that's 0.5% of the
// (default 2%) total budget carved out for floors, leaving 1.5% as the shared general pool.
const PER_STRATEGY_FLOOR_PCT = Number(args["per-strategy-floor-pct"] || "0.1") / 100;
// Out-of-sample test per iapaulo's direct request: every prior sizing-rule result (#84-#98) fit
// edgeByBucket/strategyMean on the SAME trades it then tested admission/sizing on. This mode
// instead fits the edge rule on only the first SPLIT_FRAC of history (by time, not trade count --
// a time-based split is the only one that doesn't leak future information into the fit), then
// FREEZES that rule and applies it, unmodified, to the later held-out period it never saw.
const OOS = args.oos === "true" || args.oos === "1";
const SPLIT_FRAC = Number(args["split-frac"] || "0.7");
// Walk-forward per iapaulo's follow-up to #99: instead of ONE static freeze, re-fit the edge rule
// periodically on an EXPANDING window of everything known so far, apply it causally (never on data
// from after the fit) until the next re-fit. BURN_IN gives the first fit enough data to be
// non-degenerate before any walk-forward trade is evaluated.
const WALK_FORWARD = args["walk-forward"] === "true" || args["walk-forward"] === "1";
const BURN_IN_YEARS = Number(args["burn-in-years"] || "2");
const REFIT_INTERVAL_DAYS = Number(args["refit-interval-days"] || "180");
// Sensitivity tuning per iapaulo's follow-up to #99/#100: SENSITIVITY=150 was a disclosed-arbitrary
// choice, never tuned. Selects the best value from a grid using ONLY the train period's own
// performance (standard hyperparameter-selection practice), then evaluates that ONE chosen value
// once on the untouched test period -- avoids leaking test-period information into the selection.
const TUNE_SENSITIVITY = args["tune-sensitivity"] === "true" || args["tune-sensitivity"] === "1";
const SENSITIVITY_GRID = (args["sensitivity-grid"] || "0,25,50,75,100,150,200,300,500,750,1000").split(",").map(Number);
const MIN_BUCKET_N = 30; // below this, fall back to the strategy's own overall mean (avoid noisy small-bucket edge estimates)

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
function winRate(trades) { return trades.length ? trades.filter((t) => t.pnlPct > 0).length / trades.length : null; }

// --- Strategy A (#27b, refined by #117): SMC order-block recurrence_count >= 3, all timeframes.
// Confidence now encodes #117's engulfment classification (full containment beats plain partial
// overlap, p=0.0000 at every R -- see significance-register.md #117) as a +0.5 boost on top of
// recurrence_count, so the edge-score bucketing (computeEdgeScores below) separates "recurrence=3,
// engulfment" from "recurrence=3, partial-only" into distinct buckets instead of treating them as
// the same tier the way the pre-#117 version did. Classification requires the FULL order_blocks
// set (a partner outside the recurrence>=3 filter can still determine containment), so this loads
// all order blocks first, classifies, THEN filters to the trading population -- unlike the
// original version, which queried already-filtered rows directly. Trade population/count is
// otherwise unchanged from #27b (same recurrence_count>=3 threshold, same fixed-R construction). ---

// Strategy H (#137-#144): multi-timeframe CO-OCCURRENCE breadth. A cluster is three or more rungs
// breaking SMC structure the same way inside one window (order-blind -- #137 showed ORDER is null
// once size is controlled, p=0.1226/0.4200, while SIZE is p=0.0000 on both instruments).
//
// This strategy deliberately uses its OWN stop width (2.0x ATR) rather than the file-global
// ATR_MULT of 0.6x. That is not an inconsistency: #138 showed the construction FAILS out-of-sample
// at 0.6x (BTC OOS -0.0055%) purely because the risk unit was too small relative to a 0.10% round
// trip, and #140 showed monotone improvement with stop width. 2.0x is the value frozen in the
// pre-registration (5d5220b) -- mid-range of the clearing region, deliberately not the best cell.
// Changing it here to match the other strategies would test a construction that has never been
// validated instead of the one that passed #143.
//
// Entry is the first bar STRICTLY AFTER the cluster's knownAtTime, on the cluster's FINEST rung,
// since a cluster is not observable until its last member fires.
const ATR_MULT_H = 2.0;
async function buildStrategyH(candlesByTf) {
  const clusters = buildCooccurrenceClusters(loadStructureEvents("BTC"), { mult: 1 }).filter((c) => c.K >= 3);
  const trades = [];
  for (const c of clusters) {
    const candles = candlesByTf[c.outcomeRung];
    if (!candles) continue;
    const atr14 = atr(candles, ATR_LEN);
    // first bar strictly after the cluster is observable
    let lo = 0, hi = candles.length - 1, entryIdx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (candles[m].t > c.knownAtTime) { entryIdx = m; hi = m - 1; } else lo = m + 1; }
    if (entryIdx < 0 || entryIdx >= candles.length) continue;
    const a = atr14[entryIdx];
    if (!Number.isFinite(a) || a <= 0) continue;
    const side = c.direction === "bullish" ? "long" : "short";
    const entryPrice = candles[entryIdx].o;
    const risk = ATR_MULT_H * a;
    const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
    const targetPrice = side === "long" ? entryPrice + R_MULT * risk : entryPrice - R_MULT * risk;
    const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
    if (!result) continue;
    const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
    trades.push({ strategy: "H_cooccurrence_k3", side, entryTime: candles[entryIdx].t, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, riskPct: risk / entryPrice, timeframe: c.outcomeRung, confidence: c.K });
  }
  return trades;
}

async function buildStrategyA(candlesByTf) {
  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const allObRows = db.prepare("SELECT id, timeframe, side, bar_high, bar_low, created_time, mitigated_time, recurrence_count FROM order_blocks").all();
  classifyEngulfment(allObRows);
  const obRows = allObRows.filter((o) => o.recurrence_count >= 3);
  const touchRows = db.prepare(
    `SELECT order_block_id, start_bar_idx FROM order_block_touches WHERE order_block_id IN (${obRows.map(() => "?").join(",") || "0"})`,
  ).all(...obRows.map((o) => o.id));
  db.close();
  const obById = new Map(obRows.map((o) => [o.id, o]));

  const trades = [];
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    const candles = candlesByTf[ob.timeframe];
    if (!candles) continue;
    const entryIdx = t.start_bar_idx + 1;
    if (entryIdx >= candles.length) continue;
    const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
    const side = ob.side === "bullish" ? "long" : "short";
    const stopPrice = ob.side === "bullish" ? ob.bar_low : ob.bar_high;
    const risk = Math.abs(entryPrice - stopPrice);
    if (risk <= 0) continue;
    const targetPrice = side === "long" ? entryPrice + R_MULT * risk : entryPrice - R_MULT * risk;
    const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
    if (!result) continue;
    const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
    const confidence = ob.recurrence_count + (ob.engulfmentClass === "engulfment" ? 0.5 : 0);
    trades.push({ strategy: "A_recurrence", side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, riskPct: risk / entryPrice, timeframe: ob.timeframe, confidence });
  }
  return trades;
}

// --- Strategy A2 (#120): the STRICTER variant of A -- recurrence_count>=3 AND engulfment-classified
// ONLY (partial-overlap-only excluded entirely, not just down-weighted the way A's confidence boost
// does). #120's standalone check found this pooled-worse than A (fewer trades, slightly lower
// costed expectancy) -- run through the walk-forward/OOS harness here (not done in #120) per
// iapaulo's direct ask ("if its better, test it on the walk through and wire it in") to check
// in-sample-average isn't the whole story; added ALONGSIDE A, not replacing it, so the two can be
// compared directly rather than assumed. ---
async function buildStrategyA2(candlesByTf) {
  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const allObRows = db.prepare("SELECT id, timeframe, side, bar_high, bar_low, created_time, mitigated_time, recurrence_count FROM order_blocks").all();
  classifyEngulfment(allObRows);
  const obRows = allObRows.filter((o) => o.recurrence_count >= 3 && o.engulfmentClass === "engulfment");
  const touchRows = db.prepare(
    `SELECT order_block_id, start_bar_idx FROM order_block_touches WHERE order_block_id IN (${obRows.map(() => "?").join(",") || "0"})`,
  ).all(...obRows.map((o) => o.id));
  db.close();
  const obById = new Map(obRows.map((o) => [o.id, o]));

  const trades = [];
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    const candles = candlesByTf[ob.timeframe];
    if (!candles) continue;
    const entryIdx = t.start_bar_idx + 1;
    if (entryIdx >= candles.length) continue;
    const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
    const side = ob.side === "bullish" ? "long" : "short";
    const stopPrice = ob.side === "bullish" ? ob.bar_low : ob.bar_high;
    const risk = Math.abs(entryPrice - stopPrice);
    if (risk <= 0) continue;
    const targetPrice = side === "long" ? entryPrice + R_MULT * risk : entryPrice - R_MULT * risk;
    const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
    if (!result) continue;
    const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
    trades.push({ strategy: "A2_engulfment_only", side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, riskPct: risk / entryPrice, timeframe: ob.timeframe, confidence: ob.recurrence_count });
  }
  return trades;
}

// --- Strategy B (#49): Cipher B regular divergence, 1d only, BEARISH side ---
async function buildStrategyB(candlesByTf) {
  const candles = candlesByTf["1d"];
  const atr14 = atr(candles, ATR_LEN);
  const { zones } = computeRegularDivergenceUnion(candles);
  const bearishZones = zones.filter((z) => z.side === "bearish");

  const trades = [];
  for (const z of bearishZones) {
    const i = z.confirmedBarIdx, entryIdx = i + 1;
    if (entryIdx >= candles.length || !Number.isFinite(atr14[i]) || atr14[i] <= 0) continue;
    const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
    const risk = ATR_MULT * atr14[i];
    const stopPrice = entryPrice + risk, targetPrice = entryPrice - R_MULT * risk;
    const result = simulateFixedR(candles, entryIdx, "short", stopPrice, targetPrice);
    if (!result) continue;
    const pnlPct = (entryPrice - result.exitPrice) / entryPrice;
    trades.push({ strategy: "B_1d_divergence", side: "short", entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, riskPct: risk / entryPrice, timeframe: "1d", confidence: "flat" });
  }
  return trades;
}

// --- Strategy C (#68): Cipher B regular divergence, 1h, nested 2+ of {15m,4h,1d} ---
async function buildStrategyC(candlesByTf) {
  const BASE_TF = "1h";
  const CONFIRM_TFS = { "15m": 8, "4h": 1, "1d": 1 };
  const BAR_SECONDS = { "15m": 900, "4h": 14400, "1d": 86400 };
  const baseCandles = candlesByTf[BASE_TF];
  const atr14 = atr(baseCandles, ATR_LEN);
  const { zones } = computeVmcCipherB(baseCandles);
  const regularZones = zones.filter((z) => z.kind === "regular");

  const dotBarTimesByTf = {};
  for (const tf of Object.keys(CONFIRM_TFS)) {
    const { events } = computeWtCrossSignals(candlesByTf[tf]);
    dotBarTimesByTf[tf] = {
      bullish: events.filter((e) => e.side === "bullish").map((e) => e.confirmedTime).sort((a, b) => a - b),
      bearish: events.filter((e) => e.side === "bearish").map((e) => e.confirmedTime).sort((a, b) => a - b),
    };
  }
  function countConfirmations(side, eventTime) {
    let count = 0;
    for (const [tf, windowBars] of Object.entries(CONFIRM_TFS)) {
      const times = dotBarTimesByTf[tf][side];
      if (times.length === 0) continue;
      const tolSec = windowBars * BAR_SECONDS[tf];
      let lo = 0, hi = times.length - 1, best = Infinity;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        best = Math.min(best, Math.abs(times[mid] - eventTime));
        if (times[mid] < eventTime) lo = mid + 1; else hi = mid - 1;
      }
      if (best <= tolSec) count++;
    }
    return count;
  }

  const trades = [];
  for (const z of regularZones) {
    const i = z.confirmedBarIdx, entryIdx = i + 1;
    if (entryIdx >= baseCandles.length || !Number.isFinite(atr14[i]) || atr14[i] <= 0) continue;
    const nConfirm = countConfirmations(z.side, z.confirmedTime);
    if (nConfirm < 2) continue;
    const entryPrice = baseCandles[entryIdx].o, entryTime = baseCandles[entryIdx].t;
    const side = z.side === "bullish" ? "long" : "short";
    const risk = ATR_MULT * atr14[i];
    const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
    const targetPrice = side === "long" ? entryPrice + R_MULT * risk : entryPrice - R_MULT * risk;
    const result = simulateFixedR(baseCandles, entryIdx, side, stopPrice, targetPrice);
    if (!result) continue;
    const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
    trades.push({ strategy: "C_nested_divergence", side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, riskPct: risk / entryPrice, timeframe: BASE_TF, confidence: nConfirm });
  }
  return trades;
}

// --- Strategy D (#69): Boom Hunter full-sequence + nested_boost, long-only ---
async function buildStrategyD(candlesByTf) {
  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const obRows = db.prepare(
    "SELECT id, timeframe, bar_high, bar_low, boom_full_sequence, boom_nested_boost, boom_nested_depth FROM order_blocks WHERE side = 'bullish' AND boom_full_sequence = 1 AND boom_nested_boost = 1",
  ).all();
  const touchRows = db.prepare(
    `SELECT order_block_id, start_bar_idx FROM order_block_touches WHERE order_block_id IN (${obRows.map(() => "?").join(",") || "0"})`,
  ).all(...obRows.map((o) => o.id));
  db.close();
  const obById = new Map(obRows.map((o) => [o.id, o]));

  const trades = [];
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    const candles = candlesByTf[ob.timeframe];
    if (!candles) continue;
    const entryIdx = t.start_bar_idx + 1;
    if (entryIdx >= candles.length) continue;
    const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
    const stopPrice = ob.bar_low;
    const risk = entryPrice - stopPrice;
    if (risk <= 0) continue;
    const targetPrice = entryPrice + R_MULT * risk;
    const result = simulateFixedR(candles, entryIdx, "long", stopPrice, targetPrice);
    if (!result) continue;
    const pnlPct = (result.exitPrice - entryPrice) / entryPrice;
    trades.push({ strategy: "D_boom_nested_boost", side: "long", entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, riskPct: risk / entryPrice, timeframe: ob.timeframe, confidence: ob.boom_nested_depth });
  }
  return trades;
}

// --- Strategy E (#94/#95): swing-bias-flip regime-following, 2h only (the one timeframe that
// cleared BOTH cost/capacity AND formal significance -- p=0.0402 -- not the whole 1h-4h band). Stop
// = previous swing low (long) / swing high (short), no fixed target -- hold to the next flip. ---
async function buildStrategyE(candlesByTf) {
  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const flips = db.prepare("SELECT side, bar_idx, time FROM structure_events WHERE scope = 'swing' AND type = 'CHOCH' AND timeframe = '2h' ORDER BY bar_idx ASC").all();
  db.close();
  const candles = candlesByTf["2h"];
  const pivots = computeSwingPivotSeries(candles);

  const trades = [];
  for (let i = 0; i < flips.length - 1; i++) {
    const entryIdx = flips[i].bar_idx + 1, naturalExitIdx = flips[i + 1].bar_idx + 1;
    if (entryIdx >= candles.length || naturalExitIdx >= candles.length || naturalExitIdx <= entryIdx) continue;
    const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
    const side = flips[i].side === "bullish" ? "long" : "short";
    const stopPrice = side === "long" ? pivots.swingLowLevel[flips[i].bar_idx] : pivots.swingHighLevel[flips[i].bar_idx];

    let exitIdx = naturalExitIdx, exitPrice = candles[naturalExitIdx].o, exitTime = candles[naturalExitIdx].t;
    const stopValid = Number.isFinite(stopPrice) && (side === "long" ? stopPrice < entryPrice : stopPrice > entryPrice);
    if (stopValid) {
      for (let j = entryIdx; j < naturalExitIdx; j++) {
        const bar = candles[j];
        const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
        if (hitStop) { exitIdx = j; exitPrice = stopPrice; exitTime = bar.t; break; }
      }
    }
    if (!stopValid) continue; // no valid structural stop yet this early in history -- skip rather than leave risk undefined
    const risk = Math.abs(entryPrice - stopPrice);
    if (risk <= 0) continue;
    const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
    trades.push({ strategy: "E_swing_regime_2h", side, entryTime, entryPrice, exitTime, exitPrice, pnlPct, riskPct: risk / entryPrice, timeframe: "2h", confidence: "flat" });
  }
  return trades;
}

// --- Strategy F (#106): WT extreme-anchor trade, 1d (the strongest, cleanest single cell -- n=124,
// p=0.0000 vs random-direction null, verified not outlier-driven). 0.6xATR stop, fixed R_MULT target. ---
async function buildStrategyF(candlesByTf) {
  const candles = candlesByTf["1d"];
  const atr14 = atr(candles, ATR_LEN);
  const { events: anchors } = computeWtExtremeFractals(candles);

  const trades = [];
  for (const a of anchors) {
    const entryIdx = a.barIdx + 1;
    if (entryIdx >= candles.length) continue;
    const atrAtAnchor = atr14[a.barIdx];
    if (!Number.isFinite(atrAtAnchor) || atrAtAnchor <= 0) continue;
    const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
    const side = a.side === "bullish" ? "long" : "short";
    const risk = ATR_MULT * atrAtAnchor;
    const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
    const targetPrice = side === "long" ? entryPrice + R_MULT * risk : entryPrice - R_MULT * risk;
    const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
    if (!result) continue;
    const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
    trades.push({ strategy: "F_wt_anchor_1d", side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, riskPct: risk / entryPrice, timeframe: "1d", confidence: "flat" });
  }
  return trades;
}

// --- Strategy G (#114): WT extreme-anchor, 15m, most-refined variant -- same-side OB confluence
// entry + opposite-side-OB-origin exit (#108/#109) + q5 dropping at the anchor + same-side D4M
// line confluence (#110) + AGAINST the concurrent daily regime only (#113/#114, iapaulo's confirmed
// "counter trend setup" mechanism). n=540 lifetime, p=0.0000 vs random-direction null, the highest
// per-trade costed edge of anything formally validated this session at a tradeable frequency. Never
// previously run through this file's OOS/walk-forward harness -- this is that first run. ---
async function buildStrategyG(candlesByTf) {
  const D4M_TOL_PCT = 0.012;
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const d4mDb = new DatabaseSync(D4M_DB_PATH, { readOnly: true });

  const dailyCandles = candlesByTf["1d"];
  const { events: dailyAnchors } = computeWtExtremeFractals(dailyCandles);
  const regimeTimeline = dailyAnchors.map((a) => ({ time: dailyCandles[a.barIdx].t, side: a.side })).sort((a, b) => a.time - b.time);
  function regimeAt(time) {
    let side = null;
    for (const r of regimeTimeline) { if (r.time > time) break; side = r.side; }
    return side;
  }

  const candles = candlesByTf["15m"];
  const atr14 = atr(candles, ATR_LEN);
  const { events: anchors } = computeWtExtremeFractals(candles);
  const { series } = computeBoomHunter(candles);
  const q5 = series.q5;

  const obRows = smcDb.prepare("SELECT side, bar_high, bar_low, created_bar_idx, origin_bar_idx FROM order_blocks WHERE timeframe = ? AND scope = ?").all("15m", "swing");
  const swingObsBySide = {
    bullish: obRows.filter((o) => o.side === "bullish").sort((a, b) => a.origin_bar_idx - b.origin_bar_idx),
    bearish: obRows.filter((o) => o.side === "bearish").sort((a, b) => a.origin_bar_idx - b.origin_bar_idx),
  };
  const d4mZones = d4mDb.prepare("SELECT side, price, confirmed_time, expires_time FROM zones").all();
  function hasD4mConfluence(side, obPrice, atTime) {
    const tol = obPrice * D4M_TOL_PCT;
    for (const z of d4mZones) {
      if (z.side !== side) continue;
      if (z.confirmed_time > atTime) continue;
      if (z.expires_time != null && z.expires_time < atTime) continue;
      if (Math.abs(z.price - obPrice) <= tol) return true;
    }
    return false;
  }

  const trades = [];
  for (const a of anchors) {
    const entryIdx = a.barIdx + 1;
    if (entryIdx >= candles.length) continue;
    const atrAtAnchor = atr14[a.barIdx];
    if (!Number.isFinite(atrAtAnchor) || atrAtAnchor <= 0) continue;
    const ob = obRows.find((o) => o.side === a.side && o.created_bar_idx <= a.barIdx + 2 && a.price >= o.bar_low && a.price <= o.bar_high);
    if (!ob) continue;
    if (a.barIdx - 1 < 0) continue;
    const q5Now = q5[a.barIdx], q5Then = q5[a.barIdx - 1];
    if (!Number.isFinite(q5Now) || !Number.isFinite(q5Then) || !(q5Now < q5Then)) continue;

    const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
    const obMidPrice = (ob.bar_high + ob.bar_low) / 2;
    if (!hasD4mConfluence(a.side, obMidPrice, entryTime)) continue;

    const regime = regimeAt(entryTime);
    if (regime == null || regime === a.side) continue; // counter-trend ONLY -- aligned entries excluded (#113/#114)

    const side = a.side === "bullish" ? "long" : "short";
    const risk = ATR_MULT * atrAtAnchor;
    const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
    const oppositeSide = side === "long" ? "bearish" : "bullish";
    const nextOppositeOB = swingObsBySide[oppositeSide].find((o) => o.origin_bar_idx > a.barIdx);
    const naturalExitIdx = Math.min(candles.length - 1, nextOppositeOB ? nextOppositeOB.origin_bar_idx : entryIdx + MAX_HOLD_BARS, entryIdx + MAX_HOLD_BARS);
    if (naturalExitIdx <= entryIdx) continue;
    let exitPrice = candles[naturalExitIdx].c, exitTime = candles[naturalExitIdx].t;
    for (let j = entryIdx; j <= naturalExitIdx; j++) {
      const bar = candles[j];
      const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
      if (hitStop) { exitPrice = stopPrice; exitTime = bar.t; break; }
    }
    const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
    trades.push({ strategy: "G_wt_anchor_ct_15m", side, entryTime, entryPrice, exitTime, exitPrice, pnlPct, riskPct: risk / entryPrice, timeframe: "15m", confidence: "flat" });
  }
  smcDb.close();
  d4mDb.close();
  return trades;
}

function countOverlaps(allTrades) {
  // For each trade, how many OTHER trades (any strategy) had an open position spanning its entry.
  const sorted = [...allTrades].sort((a, b) => a.entryTime - b.entryTime);
  const counts = new Array(sorted.length).fill(0);
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    for (let j = 0; j < sorted.length; j++) {
      if (i === j) continue;
      const o = sorted[j];
      if (o.entryTime <= t.entryTime && t.entryTime < o.exitTime) counts[i]++;
    }
  }
  return sorted.map((t, i) => ({ ...t, concurrentOthers: counts[i] }));
}

// Event-driven portfolio simulation with a SHARED risk budget across concurrently-open positions.
// Processes entry/exit events in true chronological order (exits before entries at the same
// instant, so closing trades free budget before new ones try to claim it). Each entry gets
// allocated min(desired RISK_PCT, remaining budget) -- 0 if the budget is already fully committed,
// which is recorded as a skip, not silently dropped. Equity is realized (multiplied) only at EXIT
// time, using the R-multiple actually achieved and the risk fraction that was actually allocated at
// entry (not the nominal desired one) -- this is what makes it valid under heavy overlap, where the
// naive "compound every trade in sequence" model isn't.
function simulatePortfolio(allTrades, { riskPctPerTrade, maxPortfolioRiskPct, minRiskPct }) {
  const events = [];
  for (const t of allTrades) {
    events.push({ time: t.entryTime, kind: "entry", trade: t });
    events.push({ time: t.exitTime, kind: "exit", trade: t });
  }
  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    // A trade's OWN entry must precede its OWN exit even when they share a timestamp (a same-bar
    // resolution -- stop/target hit on the very first checked bar) -- found 2026-08-11: the general
    // "exit before entry" tie-break (correct for freeing one trade's budget before a DIFFERENT
    // trade claims it) was wrongly applying to a trade's own pair too, processing its exit before
    // its own entry ever allocated anything, so the allocation released nothing and was never
    // freed again -- permanently leaking budget for any strategy whose trades often resolve same-bar.
    if (a.trade === b.trade) return a.kind === "entry" ? -1 : 1;
    if (a.kind === b.kind) return 0;
    return a.kind === "exit" ? -1 : 1;
  });

  let equity = 1.0, peak = 1.0, maxDrawdown = 0, openRiskSum = 0, skippedNoCapacity = 0;
  const allocatedRisk = new Map();
  const contribByStrategy = {};
  const equityCurve = [];

  for (const ev of events) {
    if (ev.kind === "entry") {
      const available = Math.max(0, maxPortfolioRiskPct - openRiskSum);
      const allocated = Math.min(riskPctPerTrade, available);
      allocatedRisk.set(ev.trade, allocated);
      if (allocated <= 0) skippedNoCapacity++;
      openRiskSum += allocated;
    } else {
      const allocated = allocatedRisk.get(ev.trade) || 0;
      openRiskSum -= allocated;
      if (allocated > 0) {
        const rAchieved = ev.trade.pnlPct / Math.max(ev.trade.riskPct, minRiskPct);
        equity *= 1 + allocated * rAchieved;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
        contribByStrategy[ev.trade.strategy] = (contribByStrategy[ev.trade.strategy] || 0) + allocated * rAchieved;
        equityCurve.push({ time: ev.time, equity });
      }
    }
  }
  return { equity, maxDrawdown, skippedNoCapacity, contribByStrategy, equityCurve, tradesTaken: allTrades.length - skippedNoCapacity };
}

// Fits mean COSTED %-RETURN (pnlPct, the same statistic every "clears costs" verdict in
// significance-register.md is based on) per (strategy, confidence-bucket), falling back to the
// strategy's own overall mean when a bucket is too thin (<MIN_BUCKET_N) to trust on its own.
// IN-SAMPLE fit -- the same trades are used to both estimate each bucket's edge AND decide
// sizing/admission on those same trades below. Disclosed, not hidden: this is a look-ahead-free
// CAUSAL sizing rule in the sense that no trade uses information from trades that haven't happened
// yet, but the bucket edge ESTIMATES themselves are fitted on the full historical sample, not a
// held-out period -- a genuinely out-of-sample validation of the prioritization rule itself is not
// done here (flagged, not solved).
//
// DELIBERATELY pnlPct, not the R-multiple (pnlPct/riskPct) used for the actual equity-impact math
// below: found by inspecting Strategy C directly that R-normalized averaging is not robust when a
// strategy's own risk% (stop distance) varies a lot trade-to-trade (C's ranges 0.16%-6.07% of
// price, 37x) -- dividing by a small risk% denominator amplifies that trade's R-multiple regardless
// of sign, and since C's losers (65% of trades, 2R target) outnumber winners, this pulled the mean R
// to -0.13 even though C's real, register-confirmed costed expectancy is +0.1057%/trade. Using
// pnlPct for the edge score keeps prioritization consistent with the exact statistic this whole
// project's "clears costs" verdicts are built on; R-multiples are still used, correctly, for sizing
// a given risk% into an actual equity change once a trade is admitted.
function computeEdgeScores(costedTrades) {
  const byBucket = new Map(), byStrategy = new Map();
  for (const t of costedTrades) {
    const bKey = `${t.strategy}:${t.confidence}`;
    if (!byBucket.has(bKey)) byBucket.set(bKey, []);
    byBucket.get(bKey).push(t.pnlPct);
    if (!byStrategy.has(t.strategy)) byStrategy.set(t.strategy, []);
    byStrategy.get(t.strategy).push(t.pnlPct);
  }
  const mean = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  const strategyMean = new Map([...byStrategy].map(([k, v]) => [k, mean(v)]));
  const edgeByBucket = new Map();
  for (const [key, arr] of byBucket) {
    const strategy = key.split(":")[0];
    edgeByBucket.set(key, { edge: arr.length >= MIN_BUCKET_N ? mean(arr) : strategyMean.get(strategy), n: arr.length, trusted: arr.length >= MIN_BUCKET_N });
  }
  return { edgeByBucket, strategyMean };
}
function edgeScoreOf(trade, edgeByBucket, strategyMean) {
  const key = `${trade.strategy}:${trade.confidence}`;
  const b = edgeByBucket.get(key);
  return b ? b.edge : strategyMean.get(trade.strategy);
}

// Same event-driven engine as simulatePortfolio, but: (a) trades with non-positive fitted edge are
// filtered out entirely (no capital, regardless of budget); (b) risk% scales with edge via a linear
// multiplier (dynamic sizing -- iapaulo's "right confidence -> dynamic leverage/position sizing"
// idea, implemented as fractional risk scaling rather than literal leverage changes, since leverage
// and risk% are the same lever in a fixed-R construction); (c) a premium tier (top
// PREMIUM_PERCENTILE of positive-edge buckets) gets its own reserved budget slice so it isn't
// crowded out by high-frequency, lower-edge flow the way #83 found `boom_nested_boost` was.
function simulatePortfolioPrioritized(allTrades, edgeByBucket, strategyMean, opts) {
  const { riskPctPerTrade, maxPortfolioRiskPct, minRiskPct, premiumReservePct } = opts;
  const generalPool = maxPortfolioRiskPct * (1 - premiumReservePct);
  const premiumPool = maxPortfolioRiskPct * premiumReservePct;

  const positiveEdges = allTrades.map((t) => edgeScoreOf(t, edgeByBucket, strategyMean)).filter((e) => e > 0).sort((a, b) => a - b);
  const premiumCutoff = positiveEdges.length ? positiveEdges[Math.floor(positiveEdges.length * PREMIUM_PERCENTILE)] : Infinity;

  const events = [];
  for (const t of allTrades) {
    events.push({ time: t.entryTime, kind: "entry", trade: t });
    events.push({ time: t.exitTime, kind: "exit", trade: t });
  }
  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    // A trade's OWN entry must precede its OWN exit even when they share a timestamp (a same-bar
    // resolution -- stop/target hit on the very first checked bar) -- found 2026-08-11: the general
    // "exit before entry" tie-break (correct for freeing one trade's budget before a DIFFERENT
    // trade claims it) was wrongly applying to a trade's own pair too, processing its exit before
    // its own entry ever allocated anything, so the allocation released nothing and was never
    // freed again -- permanently leaking budget for any strategy whose trades often resolve same-bar.
    if (a.trade === b.trade) return a.kind === "entry" ? -1 : 1;
    if (a.kind === b.kind) return 0;
    return a.kind === "exit" ? -1 : 1;
  });

  let equity = 1.0, peak = 1.0, maxDrawdown = 0, generalUsed = 0, premiumUsed = 0;
  let skippedNoEdge = 0, skippedNoCapacity = 0;
  const allocations = new Map(); // trade -> { total, fromGeneral, fromPremium }
  const contribByStrategy = {}, equityCurve = [];

  for (const ev of events) {
    if (ev.kind === "entry") {
      const edge = edgeScoreOf(ev.trade, edgeByBucket, strategyMean);
      if (edge <= 0) { skippedNoEdge++; allocations.set(ev.trade, { total: 0, fromGeneral: 0, fromPremium: 0 }); continue; }
      const isPremium = edge >= premiumCutoff;
      const sizeMult = Math.max(MIN_SIZE_MULT, Math.min(MAX_SIZE_MULT, 1 + SENSITIVITY * edge));
      const desired = riskPctPerTrade * sizeMult;

      let fromGeneral = Math.min(desired, Math.max(0, generalPool - generalUsed));
      let remaining = desired - fromGeneral;
      let fromPremium = 0;
      if (isPremium && remaining > 0) fromPremium = Math.min(remaining, Math.max(0, premiumPool - premiumUsed));
      const total = fromGeneral + fromPremium;
      if (total <= 0) skippedNoCapacity++;
      generalUsed += fromGeneral; premiumUsed += fromPremium;
      allocations.set(ev.trade, { total, fromGeneral, fromPremium });
    } else {
      const alloc = allocations.get(ev.trade) || { total: 0, fromGeneral: 0, fromPremium: 0 };
      generalUsed -= alloc.fromGeneral; premiumUsed -= alloc.fromPremium;
      if (alloc.total > 0) {
        const rAchieved = ev.trade.pnlPct / Math.max(ev.trade.riskPct, minRiskPct);
        equity *= 1 + alloc.total * rAchieved;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
        contribByStrategy[ev.trade.strategy] = (contribByStrategy[ev.trade.strategy] || 0) + alloc.total * rAchieved;
        equityCurve.push({ time: ev.time, equity });
      }
    }
  }
  return {
    equity, maxDrawdown, skippedNoEdge, skippedNoCapacity, contribByStrategy, equityCurve,
    tradesTaken: allTrades.length - skippedNoEdge - skippedNoCapacity, premiumCutoff,
  };
}

// Per-strategy reserved floor, per iapaulo's direct request after #96 found the edge-based premium
// tier does NOT protect a rare-but-strong strategy (E, +3.10%/trade, 16 signals/yr) from being
// crowded out by a much more frequent one (A, +0.27%/trade, 5,279/yr) -- A's own higher-recurrence
// buckets clear the same edge cutoff E does, so they compete for the "premium" pool too. This
// replaces that mechanism with a simpler, strategy-based guarantee: each strategy gets its OWN
// slice of the budget, reserved exclusively for it, untouchable by any other strategy regardless of
// that other strategy's own edge. Same dynamic edge-based sizing as the prioritized engine
// (STILL uses each trade's own fitted edge for size and admission) -- only the RESERVATION unit
// changes, from "top edge percentile" to "which strategy this trade belongs to".
function simulatePortfolioFloored(allTrades, edgeByBucket, strategyMean, opts) {
  const { riskPctPerTrade, maxPortfolioRiskPct, minRiskPct, perStrategyFloorPct } = opts;
  const strategies = [...new Set(allTrades.map((t) => t.strategy))];
  const totalFloor = perStrategyFloorPct * strategies.length;
  const generalPool = Math.max(0, maxPortfolioRiskPct - totalFloor);
  const floorUsed = Object.fromEntries(strategies.map((s) => [s, 0]));

  const events = [];
  for (const t of allTrades) {
    events.push({ time: t.entryTime, kind: "entry", trade: t });
    events.push({ time: t.exitTime, kind: "exit", trade: t });
  }
  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    // A trade's OWN entry must precede its OWN exit even when they share a timestamp (a same-bar
    // resolution -- stop/target hit on the very first checked bar) -- found 2026-08-11: the general
    // "exit before entry" tie-break (correct for freeing one trade's budget before a DIFFERENT
    // trade claims it) was wrongly applying to a trade's own pair too, processing its exit before
    // its own entry ever allocated anything, so the allocation released nothing and was never
    // freed again -- permanently leaking budget for any strategy whose trades often resolve same-bar.
    if (a.trade === b.trade) return a.kind === "entry" ? -1 : 1;
    if (a.kind === b.kind) return 0;
    return a.kind === "exit" ? -1 : 1;
  });

  let equity = 1.0, peak = 1.0, maxDrawdown = 0, generalUsed = 0;
  let skippedNoEdge = 0, skippedNoCapacity = 0;
  const allocations = new Map(); // trade -> { total, fromFloor, fromGeneral }
  const contribByStrategy = {}, equityCurve = [];
  const floorContribByStrategy = {}, generalContribByStrategy = {};

  for (const ev of events) {
    if (ev.kind === "entry") {
      const edge = edgeScoreOf(ev.trade, edgeByBucket, strategyMean);
      if (edge <= 0) { skippedNoEdge++; allocations.set(ev.trade, { total: 0, fromFloor: 0, fromGeneral: 0 }); continue; }
      const sizeMult = Math.max(MIN_SIZE_MULT, Math.min(MAX_SIZE_MULT, 1 + SENSITIVITY * edge));
      const desired = riskPctPerTrade * sizeMult;
      const strat = ev.trade.strategy;

      const fromFloor = Math.min(desired, Math.max(0, perStrategyFloorPct - floorUsed[strat]));
      const remaining = desired - fromFloor;
      const fromGeneral = remaining > 0 ? Math.min(remaining, Math.max(0, generalPool - generalUsed)) : 0;
      const total = fromFloor + fromGeneral;
      if (total <= 0) skippedNoCapacity++;
      floorUsed[strat] += fromFloor; generalUsed += fromGeneral;
      allocations.set(ev.trade, { total, fromFloor, fromGeneral });
    } else {
      const alloc = allocations.get(ev.trade) || { total: 0, fromFloor: 0, fromGeneral: 0 };
      const strat = ev.trade.strategy;
      floorUsed[strat] -= alloc.fromFloor; generalUsed -= alloc.fromGeneral;
      if (alloc.total > 0) {
        const rAchieved = ev.trade.pnlPct / Math.max(ev.trade.riskPct, minRiskPct);
        equity *= 1 + alloc.total * rAchieved;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
        contribByStrategy[strat] = (contribByStrategy[strat] || 0) + alloc.total * rAchieved;
        floorContribByStrategy[strat] = (floorContribByStrategy[strat] || 0) + alloc.fromFloor * rAchieved;
        generalContribByStrategy[strat] = (generalContribByStrategy[strat] || 0) + alloc.fromGeneral * rAchieved;
        equityCurve.push({ time: ev.time, equity });
      }
    }
  }
  return {
    equity, maxDrawdown, skippedNoEdge, skippedNoCapacity, contribByStrategy, floorContribByStrategy,
    generalContribByStrategy, equityCurve, tradesTaken: allTrades.length - skippedNoEdge - skippedNoCapacity,
    perStrategyFloorPct, generalPool,
  };
}

// Walk-forward variant of simulatePortfolioFloored, per iapaulo's follow-up to #99: instead of one
// static edgeByBucket/strategyMean, takes an edgeResolver(trade) -> number that looks up the
// CAUSALLY correct epoch's fit for that trade's own entry time (never a fit that used data from
// after that trade). A near-duplicate of simulatePortfolioFloored rather than a shared refactor --
// deliberately keeps the already-tested static version untouched rather than risk a new bug in it
// this late by threading a resolver function through its one shared edge-lookup call site.
function simulatePortfolioFlooredWalkForward(allTrades, edgeResolver, opts) {
  const { riskPctPerTrade, maxPortfolioRiskPct, minRiskPct, perStrategyFloorPct } = opts;
  const strategies = [...new Set(allTrades.map((t) => t.strategy))];
  const totalFloor = perStrategyFloorPct * strategies.length;
  const generalPool = Math.max(0, maxPortfolioRiskPct - totalFloor);
  const floorUsed = Object.fromEntries(strategies.map((s) => [s, 0]));

  const events = [];
  for (const t of allTrades) {
    events.push({ time: t.entryTime, kind: "entry", trade: t });
    events.push({ time: t.exitTime, kind: "exit", trade: t });
  }
  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.trade === b.trade) return a.kind === "entry" ? -1 : 1;
    if (a.kind === b.kind) return 0;
    return a.kind === "exit" ? -1 : 1;
  });

  let equity = 1.0, peak = 1.0, maxDrawdown = 0, generalUsed = 0;
  let skippedNoEdge = 0, skippedNoCapacity = 0;
  const allocations = new Map();
  const contribByStrategy = {}, equityCurve = [];
  const floorContribByStrategy = {}, generalContribByStrategy = {};

  for (const ev of events) {
    if (ev.kind === "entry") {
      const edge = edgeResolver(ev.trade);
      if (edge == null || edge <= 0) { skippedNoEdge++; allocations.set(ev.trade, { total: 0, fromFloor: 0, fromGeneral: 0 }); continue; }
      const sizeMult = Math.max(MIN_SIZE_MULT, Math.min(MAX_SIZE_MULT, 1 + SENSITIVITY * edge));
      const desired = riskPctPerTrade * sizeMult;
      const strat = ev.trade.strategy;

      const fromFloor = Math.min(desired, Math.max(0, perStrategyFloorPct - floorUsed[strat]));
      const remaining = desired - fromFloor;
      const fromGeneral = remaining > 0 ? Math.min(remaining, Math.max(0, generalPool - generalUsed)) : 0;
      const total = fromFloor + fromGeneral;
      if (total <= 0) skippedNoCapacity++;
      floorUsed[strat] += fromFloor; generalUsed += fromGeneral;
      allocations.set(ev.trade, { total, fromFloor, fromGeneral });
    } else {
      const alloc = allocations.get(ev.trade) || { total: 0, fromFloor: 0, fromGeneral: 0 };
      const strat = ev.trade.strategy;
      floorUsed[strat] -= alloc.fromFloor; generalUsed -= alloc.fromGeneral;
      if (alloc.total > 0) {
        const rAchieved = ev.trade.pnlPct / Math.max(ev.trade.riskPct, minRiskPct);
        equity *= 1 + alloc.total * rAchieved;
        peak = Math.max(peak, equity);
        maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
        contribByStrategy[strat] = (contribByStrategy[strat] || 0) + alloc.total * rAchieved;
        floorContribByStrategy[strat] = (floorContribByStrategy[strat] || 0) + alloc.fromFloor * rAchieved;
        generalContribByStrategy[strat] = (generalContribByStrategy[strat] || 0) + alloc.fromGeneral * rAchieved;
        equityCurve.push({ time: ev.time, equity });
      }
    }
  }
  return {
    equity, maxDrawdown, skippedNoEdge, skippedNoCapacity, contribByStrategy, floorContribByStrategy,
    generalContribByStrategy, equityCurve, tradesTaken: allTrades.length - skippedNoEdge - skippedNoCapacity,
  };
}

// Genuine out-of-sample test per iapaulo's direct request: every sizing-rule result through #98
// fit edgeByBucket/strategyMean on the SAME trades it then tested. This splits history
// chronologically (never by trade count -- that would leak later information into an earlier
// split point), fits the edge rule ONLY on the train period, FREEZES it, and applies it unmodified
// to the later held-out test period. Reports three numbers on the SAME test-period trades for a
// clean comparison: flat (no fitting needed, the honest baseline), floored+train-fit-edges (the
// real out-of-sample answer), and floored+test-fit-edges (an in-sample control -- refit ON the
// test period itself, the same way #98 worked -- to directly show the size of the overfitting gap
// if the train-fit version underperforms this control).
async function runOutOfSampleTest(allTrades) {
  const first = allTrades.reduce((m, t) => Math.min(m, t.entryTime), Infinity);
  const last = allTrades.reduce((m, t) => Math.max(m, t.entryTime), 0);
  const splitTime = first + SPLIT_FRAC * (last - first);
  const trainTrades = allTrades.filter((t) => t.entryTime < splitTime);
  const testTrades = allTrades.filter((t) => t.entryTime >= splitTime);

  console.log(`\n===== OUT-OF-SAMPLE TEST: split at ${new Date(splitTime * 1000).toISOString().slice(0, 10)} (${(SPLIT_FRAC * 100).toFixed(0)}% train / ${((1 - SPLIT_FRAC) * 100).toFixed(0)}% test, by time) =====`);
  console.log(`  train: ${trainTrades.length} trades, ${((splitTime - first) / (365.25 * 86400)).toFixed(2)} years`);
  console.log(`  test:  ${testTrades.length} trades, ${((last - splitTime) / (365.25 * 86400)).toFixed(2)} years`);
  console.log(`  -- per-strategy split --`);
  for (const s of new Set(allTrades.map((t) => t.strategy))) {
    const trainN = trainTrades.filter((t) => t.strategy === s).length, testN = testTrades.filter((t) => t.strategy === s).length;
    console.log(`    ${s.padEnd(22)} train=${trainN}  test=${testN}`);
  }

  const opts = { riskPctPerTrade: RISK_PCT, maxPortfolioRiskPct: MAX_PORTFOLIO_RISK_PCT, minRiskPct: MIN_RISK_PCT, perStrategyFloorPct: PER_STRATEGY_FLOOR_PCT };

  // 1. Flat sizing, test period only (no fitting needed -- same either way).
  const flatTest = simulatePortfolio(testTrades, opts);
  const flatReturnPct = (flatTest.equity - 1) * 100;

  // 2. Floored, edges fit on TRAIN only, frozen and applied to TEST -- the real answer.
  const { edgeByBucket: trainEdges, strategyMean: trainMeans } = computeEdgeScores(trainTrades);
  const oosFloored = simulatePortfolioFloored(testTrades, trainEdges, trainMeans, opts);
  const oosReturnPct = (oosFloored.equity - 1) * 100;

  // 3. Floored, edges fit on TEST itself -- in-sample control, same method as #98, to size the gap.
  const { edgeByBucket: testEdges, strategyMean: testMeans } = computeEdgeScores(testTrades);
  const inSampleFloored = simulatePortfolioFloored(testTrades, testEdges, testMeans, opts);
  const inSampleReturnPct = (inSampleFloored.equity - 1) * 100;

  console.log(`\n-- Train-fit edges (frozen, used for the real OOS run) --`);
  for (const [key, b] of [...trainEdges].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${key.padEnd(28)} n=${String(b.n).padEnd(6)} mean=${(b.edge * 100).toFixed(4)}% ${b.trusted ? "" : "(thin, using strategy mean)"}`);
  }

  console.log(`\n-- Results on the SAME held-out test period (${testTrades.length} candidate trades) --`);
  console.log(`  flat (no fitting):              $${(STARTING_BANK_USD * flatTest.equity).toFixed(2)} final, ${flatReturnPct.toFixed(1)}% return, ${(flatTest.maxDrawdown * 100).toFixed(1)}% max DD, ${flatTest.tradesTaken} trades taken`);
  console.log(`  floored, TRAIN-fit edges (OOS):  $${(STARTING_BANK_USD * oosFloored.equity).toFixed(2)} final, ${oosReturnPct.toFixed(1)}% return, ${(oosFloored.maxDrawdown * 100).toFixed(1)}% max DD, ${oosFloored.tradesTaken} trades taken`);
  console.log(`  floored, TEST-fit edges (in-sample control): $${(STARTING_BANK_USD * inSampleFloored.equity).toFixed(2)} final, ${inSampleReturnPct.toFixed(1)}% return, ${(inSampleFloored.maxDrawdown * 100).toFixed(1)}% max DD, ${inSampleFloored.tradesTaken} trades taken`);
  console.log(`\n-- Per-strategy contribution, OOS (train-fit edges applied to test) --`);
  for (const [name, contrib] of Object.entries(oosFloored.contribByStrategy)) {
    console.log(`  ${name.padEnd(22)} ${(contrib * 100).toFixed(1)}pts`);
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = {
    splitFrac: SPLIT_FRAC, splitTime, trainCount: trainTrades.length, testCount: testTrades.length,
    flat: { finalBankUsd: STARTING_BANK_USD * flatTest.equity, returnPct: flatReturnPct, maxDrawdownPct: flatTest.maxDrawdown * 100, tradesTaken: flatTest.tradesTaken },
    oosFloored: { finalBankUsd: STARTING_BANK_USD * oosFloored.equity, returnPct: oosReturnPct, maxDrawdownPct: oosFloored.maxDrawdown * 100, tradesTaken: oosFloored.tradesTaken, contribByStrategy: oosFloored.contribByStrategy },
    inSampleFloored: { finalBankUsd: STARTING_BANK_USD * inSampleFloored.equity, returnPct: inSampleReturnPct, maxDrawdownPct: inSampleFloored.maxDrawdown * 100, tradesTaken: inSampleFloored.tradesTaken },
    trainEdgeByBucket: Object.fromEntries([...trainEdges]),
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const fname = `portfolio_oos_test_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

// Walk-forward test per iapaulo's follow-up to #99: re-fits the edge rule periodically on an
// EXPANDING window of everything known up to that point (not one static freeze), applies it
// causally to trades until the next re-fit. Every trade's sizing decision uses only a fit built
// from STRICTLY EARLIER data -- no look-ahead at any point, unlike #99's single-freeze OOS test
// which answers "does a rule frozen once survive," this answers "does periodically updating the
// rule as new data arrives do better than never updating it (#99) or never fitting at all (flat)."
async function runWalkForwardTest(allTrades) {
  const first = allTrades.reduce((m, t) => Math.min(m, t.entryTime), Infinity);
  const last = allTrades.reduce((m, t) => Math.max(m, t.entryTime), 0);
  const burnInSeconds = BURN_IN_YEARS * 365.25 * 86400;
  const refitIntervalSeconds = REFIT_INTERVAL_DAYS * 86400;
  const firstRefit = first + burnInSeconds;

  // Build the sequence of refit points and, for each, fit edgeByBucket/strategyMean on an
  // EXPANDING window of all trades with entryTime STRICTLY BEFORE that refit point.
  const refitPoints = [];
  for (let t = firstRefit; t <= last; t += refitIntervalSeconds) refitPoints.push(t);
  if (refitPoints.length === 0 || refitPoints[refitPoints.length - 1] < last) refitPoints.push(last + 1);

  const epochs = refitPoints.map((refitTime) => {
    const windowTrades = allTrades.filter((t) => t.entryTime < refitTime);
    const { edgeByBucket, strategyMean } = computeEdgeScores(windowTrades);
    return { refitTime, edgeByBucket, strategyMean, windowN: windowTrades.length };
  });

  console.log(`\n===== WALK-FORWARD TEST: ${BURN_IN_YEARS}yr burn-in, re-fit every ${REFIT_INTERVAL_DAYS} days, expanding window =====`);
  console.log(`  first refit: ${new Date(firstRefit * 1000).toISOString().slice(0, 10)} (n=${epochs[0]?.windowN ?? 0} trades in the window)`);
  console.log(`  ${epochs.length} total refit epochs through ${new Date(last * 1000).toISOString().slice(0, 10)}`);

  function edgeResolver(trade) {
    // Find the LAST epoch whose refitTime <= trade.entryTime -- the most recent fit that only used
    // data strictly before this trade could have been sized. Binary search over sorted refitPoints.
    let lo = 0, hi = epochs.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (epochs[mid].refitTime <= trade.entryTime) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (ans === -1) return null; // before the first refit -- excluded (matches the OOS test's burn-in exclusion)
    return edgeScoreOf(trade, epochs[ans].edgeByBucket, epochs[ans].strategyMean);
  }

  const evalTrades = allTrades.filter((t) => t.entryTime >= firstRefit);
  const opts = { riskPctPerTrade: RISK_PCT, maxPortfolioRiskPct: MAX_PORTFOLIO_RISK_PCT, minRiskPct: MIN_RISK_PCT, perStrategyFloorPct: PER_STRATEGY_FLOOR_PCT };

  const flatEval = simulatePortfolio(evalTrades, opts);
  const flatReturnPct = (flatEval.equity - 1) * 100;

  const wfFloored = simulatePortfolioFlooredWalkForward(evalTrades, edgeResolver, opts);
  const wfReturnPct = (wfFloored.equity - 1) * 100;

  console.log(`\n-- Results on the post-burn-in evaluation period (${evalTrades.length} candidate trades, ${((last - firstRefit) / (365.25 * 86400)).toFixed(2)} years) --`);
  console.log(`  flat (no fitting):                    $${(STARTING_BANK_USD * flatEval.equity).toFixed(2)} final, ${flatReturnPct.toFixed(1)}% return, ${(flatEval.maxDrawdown * 100).toFixed(1)}% max DD, ${flatEval.tradesTaken} trades taken`);
  console.log(`  floored, WALK-FORWARD edges:           $${(STARTING_BANK_USD * wfFloored.equity).toFixed(2)} final, ${wfReturnPct.toFixed(1)}% return, ${(wfFloored.maxDrawdown * 100).toFixed(1)}% max DD, ${wfFloored.tradesTaken} trades taken`);
  console.log(`\n-- Per-strategy contribution, walk-forward --`);
  for (const [name, contrib] of Object.entries(wfFloored.contribByStrategy)) {
    console.log(`  ${name.padEnd(22)} ${(contrib * 100).toFixed(1)}pts`);
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = {
    burnInYears: BURN_IN_YEARS, refitIntervalDays: REFIT_INTERVAL_DAYS, epochCount: epochs.length, evalTradeCount: evalTrades.length,
    flat: { finalBankUsd: STARTING_BANK_USD * flatEval.equity, returnPct: flatReturnPct, maxDrawdownPct: flatEval.maxDrawdown * 100, tradesTaken: flatEval.tradesTaken },
    walkForwardFloored: { finalBankUsd: STARTING_BANK_USD * wfFloored.equity, returnPct: wfReturnPct, maxDrawdownPct: wfFloored.maxDrawdown * 100, tradesTaken: wfFloored.tradesTaken, contribByStrategy: wfFloored.contribByStrategy },
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const fname = `portfolio_walk_forward_test_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

// Sensitivity tuning, per iapaulo's follow-up to #99/#100: was SENSITIVITY=150 just a bad guess?
// Same 70/30 chronological split as #99. Grid-search SENSITIVITY using ONLY the train period's own
// (in-sample-on-train) performance to pick a winner -- normal hyperparameter selection practice --
// then apply that ONE chosen value (edges still fit on train only) to the untouched test period
// exactly once, so the test period is never used to pick among candidates, only to report the
// final, honest verdict on the winner.
async function runSensitivityTuningTest(allTrades) {
  const first = allTrades.reduce((m, t) => Math.min(m, t.entryTime), Infinity);
  const last = allTrades.reduce((m, t) => Math.max(m, t.entryTime), 0);
  const splitTime = first + SPLIT_FRAC * (last - first);
  const trainTrades = allTrades.filter((t) => t.entryTime < splitTime);
  const testTrades = allTrades.filter((t) => t.entryTime >= splitTime);
  const opts = { riskPctPerTrade: RISK_PCT, maxPortfolioRiskPct: MAX_PORTFOLIO_RISK_PCT, minRiskPct: MIN_RISK_PCT, perStrategyFloorPct: PER_STRATEGY_FLOOR_PCT };

  const { edgeByBucket: trainEdges, strategyMean: trainMeans } = computeEdgeScores(trainTrades);

  console.log(`\n===== SENSITIVITY TUNING: grid-search on TRAIN (${trainTrades.length} trades), evaluate winner on TEST (${testTrades.length} trades) =====`);
  console.log(`  split at ${new Date(splitTime * 1000).toISOString().slice(0, 10)} (${(SPLIT_FRAC * 100).toFixed(0)}%/${((1 - SPLIT_FRAC) * 100).toFixed(0)}%)`);
  console.log(`\n-- Grid search on TRAIN period (selecting by train return, edges fit on train) --`);
  let best = null;
  for (const s of SENSITIVITY_GRID) {
    SENSITIVITY = s;
    const trainResult = simulatePortfolioFloored(trainTrades, trainEdges, trainMeans, opts);
    const trainReturnPct = (trainResult.equity - 1) * 100;
    console.log(`  sensitivity=${String(s).padEnd(6)} train_return=${trainReturnPct.toFixed(1)}%  train_maxDD=${(trainResult.maxDrawdown * 100).toFixed(1)}%  trades=${trainResult.tradesTaken}`);
    if (!best || trainReturnPct > best.trainReturnPct) best = { sensitivity: s, trainReturnPct };
  }
  console.log(`\n  winner: sensitivity=${best.sensitivity} (train_return=${best.trainReturnPct.toFixed(1)}%)`);

  // Evaluate the winner ONCE on the untouched test period, edges still fit on train only (same
  // out-of-sample discipline as #99 -- only the hyperparameter, not the edge fit itself, came from
  // a search; the search never touched test).
  SENSITIVITY = best.sensitivity;
  const tunedTest = simulatePortfolioFloored(testTrades, trainEdges, trainMeans, opts);
  const tunedReturnPct = (tunedTest.equity - 1) * 100;

  SENSITIVITY = 150; // restore the original default for the flat/untuned comparison below
  const flatTest = simulatePortfolio(testTrades, opts);
  const flatReturnPct = (flatTest.equity - 1) * 100;
  const untunedTest = simulatePortfolioFloored(testTrades, trainEdges, trainMeans, opts);
  const untunedReturnPct = (untunedTest.equity - 1) * 100;

  console.log(`\n-- Final results on the untouched TEST period (${testTrades.length} trades) --`);
  console.log(`  flat (no fitting):                    $${(STARTING_BANK_USD * flatTest.equity).toFixed(2)} final, ${flatReturnPct.toFixed(1)}% return, ${(flatTest.maxDrawdown * 100).toFixed(1)}% max DD`);
  console.log(`  floored, sensitivity=150 (#99's default): $${(STARTING_BANK_USD * untunedTest.equity).toFixed(2)} final, ${untunedReturnPct.toFixed(1)}% return, ${(untunedTest.maxDrawdown * 100).toFixed(1)}% max DD`);
  console.log(`  floored, sensitivity=${best.sensitivity} (train-tuned):  $${(STARTING_BANK_USD * tunedTest.equity).toFixed(2)} final, ${tunedReturnPct.toFixed(1)}% return, ${(tunedTest.maxDrawdown * 100).toFixed(1)}% max DD`);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = {
    splitFrac: SPLIT_FRAC, sensitivityGrid: SENSITIVITY_GRID, winnerSensitivity: best.sensitivity, winnerTrainReturnPct: best.trainReturnPct,
    flat: { finalBankUsd: STARTING_BANK_USD * flatTest.equity, returnPct: flatReturnPct, maxDrawdownPct: flatTest.maxDrawdown * 100 },
    untuned150: { finalBankUsd: STARTING_BANK_USD * untunedTest.equity, returnPct: untunedReturnPct, maxDrawdownPct: untunedTest.maxDrawdown * 100 },
    tuned: { finalBankUsd: STARTING_BANK_USD * tunedTest.equity, returnPct: tunedReturnPct, maxDrawdownPct: tunedTest.maxDrawdown * 100 },
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const fname = `portfolio_sensitivity_tuning_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

async function main() {
  const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
  const candlesByTf = {};
  for (const tf of LADDER_KEYS) candlesByTf[tf] = await loadCandles(tf);

  console.log(`Portfolio backtest: R=${R_MULT}, risk/trade=${(RISK_PCT * 100).toFixed(2)}% of equity, fee tier=${FEE_TIER} (round-trip=${(FEE_TIERS[FEE_TIER].takerFeePct * 200).toFixed(3)}%)\n`);

  const [rawA, rawA2, rawB, rawC, rawD, rawE, rawF, rawG, rawH] = await Promise.all([
    buildStrategyA(candlesByTf), buildStrategyA2(candlesByTf), buildStrategyB(candlesByTf), buildStrategyC(candlesByTf), buildStrategyD(candlesByTf), buildStrategyE(candlesByTf), buildStrategyF(candlesByTf), buildStrategyG(candlesByTf), buildStrategyH(candlesByTf),
  ]);
  const costParams = { takerFeePct: FEE_TIERS[FEE_TIER].takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const stratMap = { A_recurrence: rawA, A2_engulfment_only: rawA2, B_1d_divergence: rawB, C_nested_divergence: rawC, D_boom_nested_boost: rawD, E_swing_regime_2h: rawE, F_wt_anchor_1d: rawF, G_wt_anchor_ct_15m: rawG, H_cooccurrence_k3: rawH };

  console.log("-- Per-strategy sanity check (should match register rows within noise) --");
  const perStrategySummary = {};
  for (const [name, raw] of Object.entries(stratMap)) {
    const costed = applyCosts(raw, costParams);
    const grossExp = expectancy(raw), costedExp = expectancy(costed);
    const first = raw.reduce((min, t) => Math.min(min, t.entryTime), Infinity), last = raw.reduce((max, t) => Math.max(max, t.entryTime), 0);
    const spanYears = raw.length ? (last - first) / (365.25 * 86400) : 0;
    console.log(`  ${name.padEnd(22)} n=${String(raw.length).padEnd(6)} (${(raw.length / Math.max(spanYears, 0.01)).toFixed(1)}/yr) win=${((winRate(raw) || 0) * 100).toFixed(1)}% gross_exp=${(grossExp * 100).toFixed(4)}%/trade costed_exp=${(costedExp * 100).toFixed(4)}%/trade ${costedExp > 0 ? "(clears costs)" : "(BLOCKED)"}`);
    perStrategySummary[name] = { trade_count: raw.length, trades_per_year: raw.length / Math.max(spanYears, 0.01), win_rate: winRate(raw), gross_expectancy_pct_per_trade: grossExp, costed_expectancy_pct_per_trade: costedExp };
  }

  // Combine, cost, sort chronologically, compute overlap.
  // A and A2 are NOT both included in the combined simulation -- A2's population is a strict
  // subset of A's (same order blocks, filtered further), so including both would double-book the
  // same underlying market exposure under two strategy labels and distort the shared-budget
  // accounting. --strategy-a-variant=a2 swaps A2 in for A (for the #120 walk-forward/OOS
  // comparison); default stays "a", preserving every prior run's behavior unchanged.
  // Default flipped to A2 2026-08-12 (#121): A2 clearly beats A on BOTH out-of-sample tests
  // (walk-forward contribution ~3x higher, OOS loss ~half as large) despite a slightly lower
  // in-sample pooled average (#120) -- forward persistence is the metric that matters for a live
  // decision. --strategy-a-variant=a recovers the original A for comparison, not deleted.
  const useA2 = (args["strategy-a-variant"] || "a2") === "a2";
  let allTrades = [...(useA2 ? rawA2 : rawA), ...rawB, ...rawC, ...rawD, ...rawE, ...rawF, ...rawG, ...rawH];
  allTrades = applyCosts(allTrades, costParams);
  allTrades = countOverlaps(allTrades);
  allTrades.sort((a, b) => a.entryTime - b.entryTime || a.exitTime - b.exitTime);

  if (OOS) { await runOutOfSampleTest(allTrades); return; }
  if (WALK_FORWARD) { await runWalkForwardTest(allTrades); return; }
  if (TUNE_SENSITIVITY) { await runSensitivityTuningTest(allTrades); return; }

  console.log(`\n-- Combined portfolio: ${allTrades.length} trades, chronological, shared risk budget=${(MAX_PORTFOLIO_RISK_PCT * 100).toFixed(2)}% --`);

  const sim = simulatePortfolio(allTrades, { riskPctPerTrade: RISK_PCT, maxPortfolioRiskPct: MAX_PORTFOLIO_RISK_PCT, minRiskPct: MIN_RISK_PCT });
  const { equity, maxDrawdown, skippedNoCapacity, contribByStrategy, tradesTaken } = sim;
  const totalReturnPct = (equity - 1) * 100;
  const first = allTrades[0]?.entryTime, last = allTrades[allTrades.length - 1]?.entryTime;
  const spanYears = (last - first) / (365.25 * 86400);
  const cagr = spanYears > 0 && equity > 0 ? (Math.pow(equity, 1 / spanYears) - 1) * 100 : null;

  console.log(`  total return: ${totalReturnPct.toExponential(3)}% over ${spanYears.toFixed(2)} years (CAGR ${cagr?.toFixed(1)}%)`);
  console.log(`  max drawdown: ${(maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  final equity multiple: ${equity.toExponential(3)}x starting capital`);
  console.log(`  trades skipped, no budget available: ${skippedNoCapacity}/${allTrades.length} (${((skippedNoCapacity / allTrades.length) * 100).toFixed(1)}%) -- ${tradesTaken} actually taken (full or partial size)`);

  console.log(`\n-- Per-strategy contribution (sum of allocated-risk-weighted R, realized at exit) --`);
  for (const [name, contrib] of Object.entries(contribByStrategy)) {
    console.log(`  ${name.padEnd(22)} sum(risk-weighted R) = ${(contrib * 100).toFixed(1)}pts of equity`);
  }

  // Overlap: how often does a trade share the books with 1+ other open positions from ANY strategy.
  console.log(`\n-- Concurrent-exposure check (same BTC underlying across all 4 strategies) --`);
  const overlapDist = {};
  for (const t of allTrades) overlapDist[t.concurrentOthers] = (overlapDist[t.concurrentOthers] || 0) + 1;
  const maxConcurrent = Math.max(...Object.keys(overlapDist).map(Number));
  for (let k = 0; k <= Math.min(maxConcurrent, 10); k++) {
    const n = overlapDist[k] || 0;
    console.log(`  ${k} other position(s) open at entry: ${n} trades (${((n / allTrades.length) * 100).toFixed(1)}%)`);
  }
  if (maxConcurrent > 10) console.log(`  ... up to ${maxConcurrent} concurrent at the busiest moment`);
  const pctWithOverlap = allTrades.filter((t) => t.concurrentOthers > 0).length / allTrades.length;
  console.log(`  ${(pctWithOverlap * 100).toFixed(1)}% of trades had at least one other strategy's position open simultaneously`);

  console.log(`\n$${STARTING_BANK_USD} starting bank (flat sizing): final=$${(STARTING_BANK_USD * equity).toFixed(2)}, max drawdown=$${(STARTING_BANK_USD * maxDrawdown).toFixed(2)}`);

  // --- Prioritized / dynamically-sized run ---
  console.log(`\n\n===== PRIORITIZED: dynamic sizing by fitted edge, ${(PREMIUM_RESERVE_PCT * 100).toFixed(0)}% budget reserved for top-${((1 - PREMIUM_PERCENTILE) * 100).toFixed(0)}% edge tier =====`);
  const { edgeByBucket, strategyMean } = computeEdgeScores(allTrades);
  console.log(`\n-- Fitted edge by confidence bucket (mean costed %-return/trade, IN-SAMPLE) --`);
  for (const [key, b] of [...edgeByBucket].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${key.padEnd(28)} n=${String(b.n).padEnd(6)} mean=${(b.edge * 100).toFixed(4)}% ${b.trusted ? "" : "(thin, using strategy mean)"}`);
  }
  console.log(`  -- strategy overall means (fallback) --`);
  for (const [k, v] of strategyMean) console.log(`  ${k.padEnd(28)} mean=${(v * 100).toFixed(4)}%`);

  const prioritized = simulatePortfolioPrioritized(allTrades, edgeByBucket, strategyMean, {
    riskPctPerTrade: RISK_PCT, maxPortfolioRiskPct: MAX_PORTFOLIO_RISK_PCT, minRiskPct: MIN_RISK_PCT, premiumReservePct: PREMIUM_RESERVE_PCT,
  });
  const pTotalReturnPct = (prioritized.equity - 1) * 100;
  const pCagr = spanYears > 0 && prioritized.equity > 0 ? (Math.pow(prioritized.equity, 1 / spanYears) - 1) * 100 : null;
  console.log(`\n-- Prioritized portfolio result (premium edge cutoff: ${(prioritized.premiumCutoff * 100).toFixed(4)}%) --`);
  console.log(`  total return: ${pTotalReturnPct.toExponential(3)}% over ${spanYears.toFixed(2)} years (CAGR ${pCagr?.toFixed(1)}%)`);
  console.log(`  max drawdown: ${(prioritized.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  final equity multiple: ${prioritized.equity.toExponential(3)}x starting capital`);
  console.log(`  skipped, non-positive fitted edge: ${prioritized.skippedNoEdge}/${allTrades.length} (${((prioritized.skippedNoEdge / allTrades.length) * 100).toFixed(1)}%)`);
  console.log(`  skipped, no budget after edge filter: ${prioritized.skippedNoCapacity}/${allTrades.length} (${((prioritized.skippedNoCapacity / allTrades.length) * 100).toFixed(1)}%)`);
  console.log(`  actually taken: ${prioritized.tradesTaken}/${allTrades.length}`);
  console.log(`  $${STARTING_BANK_USD} starting bank: final=$${(STARTING_BANK_USD * prioritized.equity).toFixed(2)}, max drawdown=$${(STARTING_BANK_USD * prioritized.maxDrawdown).toFixed(2)}`);
  console.log(`\n-- Per-strategy contribution (prioritized) --`);
  for (const [name, contrib] of Object.entries(prioritized.contribByStrategy)) {
    console.log(`  ${name.padEnd(22)} sum(risk-weighted R) = ${(contrib * 100).toFixed(1)}pts of equity`);
  }
  // --- Floored run: per-strategy reserved budget (#96's fix) ---
  const strategyCount = new Set(allTrades.map((t) => t.strategy)).size;
  console.log(`\n\n===== FLOORED: per-strategy reserved budget (${(PER_STRATEGY_FLOOR_PCT * 100).toFixed(2)}% x ${strategyCount} strategies = ${(PER_STRATEGY_FLOOR_PCT * strategyCount * 100).toFixed(2)}% reserved, ${(Math.max(0, MAX_PORTFOLIO_RISK_PCT - PER_STRATEGY_FLOOR_PCT * strategyCount) * 100).toFixed(2)}% shared general pool) =====`);
  const floored = simulatePortfolioFloored(allTrades, edgeByBucket, strategyMean, {
    riskPctPerTrade: RISK_PCT, maxPortfolioRiskPct: MAX_PORTFOLIO_RISK_PCT, minRiskPct: MIN_RISK_PCT, perStrategyFloorPct: PER_STRATEGY_FLOOR_PCT,
  });
  const fTotalReturnPct = (floored.equity - 1) * 100;
  const fCagr = spanYears > 0 && floored.equity > 0 ? (Math.pow(floored.equity, 1 / spanYears) - 1) * 100 : null;
  console.log(`  total return: ${fTotalReturnPct.toExponential(3)}% over ${spanYears.toFixed(2)} years (CAGR ${fCagr?.toFixed(1)}%)`);
  console.log(`  max drawdown: ${(floored.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  final equity multiple: ${floored.equity.toExponential(3)}x starting capital`);
  console.log(`  skipped, non-positive fitted edge: ${floored.skippedNoEdge}/${allTrades.length} (${((floored.skippedNoEdge / allTrades.length) * 100).toFixed(1)}%)`);
  console.log(`  skipped, no budget after edge filter: ${floored.skippedNoCapacity}/${allTrades.length} (${((floored.skippedNoCapacity / allTrades.length) * 100).toFixed(1)}%)`);
  console.log(`  actually taken: ${floored.tradesTaken}/${allTrades.length}`);
  console.log(`  $${STARTING_BANK_USD} starting bank: final=$${(STARTING_BANK_USD * floored.equity).toFixed(2)}, max drawdown=$${(STARTING_BANK_USD * floored.maxDrawdown).toFixed(2)}`);
  console.log(`\n-- Per-strategy contribution (floored, split by which pool it came from) --`);
  for (const name of Object.keys(floored.contribByStrategy)) {
    const total = floored.contribByStrategy[name] || 0, fromFloor = floored.floorContribByStrategy[name] || 0, fromGeneral = floored.generalContribByStrategy[name] || 0;
    console.log(`  ${name.padEnd(22)} total=${(total * 100).toFixed(1)}pts  (from own floor=${(fromFloor * 100).toFixed(1)}pts, from general pool=${(fromGeneral * 100).toFixed(1)}pts)`);
  }
  for (const s of new Set(allTrades.map((t) => t.strategy))) {
    if (!(s in floored.contribByStrategy)) console.log(`  ${s.padEnd(22)} total=0.0pts  -- STILL zero trades taken`);
  }

  console.log(`\n-- Comparison: flat vs prioritized vs floored, all at ${(MAX_PORTFOLIO_RISK_PCT * 100).toFixed(2)}% budget --`);
  console.log(`  flat:        $${(STARTING_BANK_USD * equity).toFixed(2)} final, ${(maxDrawdown * 100).toFixed(1)}% max DD, ${tradesTaken} trades taken`);
  console.log(`  prioritized: $${(STARTING_BANK_USD * prioritized.equity).toFixed(2)} final, ${(prioritized.maxDrawdown * 100).toFixed(1)}% max DD, ${prioritized.tradesTaken} trades taken`);
  console.log(`  floored:     $${(STARTING_BANK_USD * floored.equity).toFixed(2)} final, ${(floored.maxDrawdown * 100).toFixed(1)}% max DD, ${floored.tradesTaken} trades taken`);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = {
    config: {
      rMultiple: R_MULT, riskPctPerTrade: RISK_PCT, maxPortfolioRiskPct: MAX_PORTFOLIO_RISK_PCT, feeTier: FEE_TIER,
      startingBankUsd: STARTING_BANK_USD, sensitivity: SENSITIVITY, minSizeMult: MIN_SIZE_MULT, maxSizeMult: MAX_SIZE_MULT,
      premiumPercentile: PREMIUM_PERCENTILE, premiumReservePct: PREMIUM_RESERVE_PCT, perStrategyFloorPct: PER_STRATEGY_FLOOR_PCT,
    },
    perStrategy: perStrategySummary,
    flat: {
      tradeCount: allTrades.length, tradesTaken, skippedNoCapacity, spanYears, totalReturnPct, cagr,
      maxDrawdownPct: maxDrawdown * 100, finalEquityMultiple: equity, finalBankUsd: STARTING_BANK_USD * equity,
      contribByStrategy,
    },
    prioritized: {
      tradesTaken: prioritized.tradesTaken, skippedNoEdge: prioritized.skippedNoEdge, skippedNoCapacity: prioritized.skippedNoCapacity,
      totalReturnPct: pTotalReturnPct, cagr: pCagr, maxDrawdownPct: prioritized.maxDrawdown * 100,
      finalEquityMultiple: prioritized.equity, finalBankUsd: STARTING_BANK_USD * prioritized.equity,
      premiumCutoff: prioritized.premiumCutoff, contribByStrategy: prioritized.contribByStrategy,
      edgeByBucket: Object.fromEntries([...edgeByBucket].map(([k, v]) => [k, v])),
    },
    floored: {
      tradesTaken: floored.tradesTaken, skippedNoEdge: floored.skippedNoEdge, skippedNoCapacity: floored.skippedNoCapacity,
      totalReturnPct: fTotalReturnPct, cagr: fCagr, maxDrawdownPct: floored.maxDrawdown * 100,
      finalEquityMultiple: floored.equity, finalBankUsd: STARTING_BANK_USD * floored.equity,
      contribByStrategy: floored.contribByStrategy, floorContribByStrategy: floored.floorContribByStrategy,
      generalContribByStrategy: floored.generalContribByStrategy,
    },
    overlapDist,
    pctWithOverlap,
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const fname = `portfolio_backtest_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

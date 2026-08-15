#!/usr/bin/env node
// Validates register #59 (nested MTF confirmation on Cipher B WT regular divergence, 1h) IN this
// project's own JS pipeline -- #59 was built entirely in an independent Python stack
// (ai-quant-workbench, scripts/signal-bus/vmc-cipher-b-nested-wt/nested_confirmation_significance.py),
// against a separately-pulled Coinbase data series and a SIMPLER, disclosed-as-not-a-port pivot
// divergence detector, deliberately to see whether an independent implementation reached the same
// conclusion. It never ran against the house's own, more elaborate, already-validated `regular`
// divergence detector (computeVmcCipherB, with the "2nd WT Regular Divergence" gate -- #51/#52) or
// this project's own historical data (Binance->Coinbase splice via load-candles.js). This file
// closes that gap: same core hypothesis (does a same-side buySignal/sellSignal "dot" on 2+ of
// {15m, 4h, 1d} within a TF-scaled window, confirming a 1h regular divergence, predict a better
// outcome than 0-1 confirmations), tested on the house's own detector and data.
//
// ONE deliberate, disclosed substitution from the Python original: {15m, 6h, 1d} -> {15m, 4h, 1d}.
// This project's 8-rung ladder has never included a 6H timeframe (confirmed multiple times this
// session, e.g. decision-policy.md's EOT3 section) -- 4H is the nearest real rung, same substitution
// already made for the Boom Hunter nested-cascade work (#61).
//
// Trade construction identical to divergence-cost-capacity-backtest.js (the house's own established
// convention): entry = next-bar-open after the divergence zone's own confirmation bar; risk = 0.6x
// ATR(14) Wilder at that bar; stop = entry -/+ risk; target = entry +/- R x risk; race-to-target-or-
// stop, max 200 bars. Real costs from costs.js's confirmed_derivatives tier + representative
// funding -- tests BOTH significance (point-biserial + top-vs-bottom gap, mirroring
// recurrence-fixed-rr-significance.js) AND real cost/capacity, since that's the two-stage bar #59
// itself needs to clear here to count as validated, not just replicated in spirit.
//
// Usage: node scripts/signal-bus/cross-confluence/nested-mtf-divergence-validation.js [--iterations=50000] [--r=1,1.5,2,3]

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeVmcCipherB, computeWtCrossSignals } from "../vmc-cipher-b/calc.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "50000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const BASE_TF = "1h";
const ATR_LEN = 14;
const ATR_MULT = 0.6;
const MAX_HOLD_BARS = 200;
// TF-scaled confirmation windows, bars of THAT timeframe -- same shape as the Python original
// (15m:8bars~2h, 1d:1bar~1day), 4h substituted for 6h at 1 bar (~4h, close to the original's ~6h).
const CONFIRM_TFS = { "15m": 8, "4h": 1, "1d": 1 };

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
    if (hitStop) return { exitPrice: stopPrice, exitTime: bar.t, outcome: "stop" };
    if (hitTarget) return { exitPrice: targetPrice, exitTime: bar.t, outcome: "target" };
  }
  return null;
}
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function pointBiserial(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}
function topVsBottomGap(xs, ys) {
  const maxX = Math.max(...xs, 0);
  const bottom = ys.filter((_, i) => xs[i] === 0), top = ys.filter((_, i) => xs[i] === maxX);
  if (top.length === 0 || bottom.length === 0 || maxX === 0) return null;
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  return { gap: mean(top) - mean(bottom), nTop: top.length, nBottom: bottom.length, maxX };
}

async function main() {
  const candlesByTf = {};
  for (const tf of [BASE_TF, ...Object.keys(CONFIRM_TFS)]) candlesByTf[tf] = await loadCandles(tf);
  const baseCandles = candlesByTf[BASE_TF];
  const atr14 = atr(baseCandles, ATR_LEN);

  const { zones } = computeVmcCipherB(baseCandles);
  const regularZones = zones.filter((z) => z.kind === "regular");
  console.log(`${BASE_TF}: ${regularZones.length} Cipher B regular WT divergence events (bearish=${regularZones.filter((z) => z.side === "bearish").length}, bullish=${regularZones.filter((z) => z.side === "bullish").length})`);

  // Confirmation dot times per confirming timeframe, per side.
  const dotBarTimesByTf = {};
  for (const tf of Object.keys(CONFIRM_TFS)) {
    const { events } = computeWtCrossSignals(candlesByTf[tf]);
    dotBarTimesByTf[tf] = {
      bullish: events.filter((e) => e.side === "bullish").map((e) => e.confirmedTime).sort((a, b) => a - b),
      bearish: events.filter((e) => e.side === "bearish").map((e) => e.confirmedTime).sort((a, b) => a - b),
    };
  }
  const BAR_SECONDS = { "15m": 900, "4h": 14400, "1d": 86400 };
  function countConfirmations(side, eventTime) {
    let count = 0;
    for (const [tf, windowBars] of Object.entries(CONFIRM_TFS)) {
      const times = dotBarTimesByTf[tf][side];
      if (times.length === 0) continue;
      const tolSec = windowBars * BAR_SECONDS[tf];
      // times is sorted -- binary search for nearest.
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

  const labeled = regularZones.map((z) => {
    const i = z.confirmedBarIdx;
    return { ...z, entryIdx: i + 1, atrAtSignal: atr14[i], nConfirm: countConfirmations(z.side, z.confirmedTime) };
  }).filter((z) => z.entryIdx < baseCandles.length && Number.isFinite(z.atrAtSignal) && z.atrAtSignal > 0);
  console.log(`${labeled.length} events with valid ATR(14) and a tradeable next-bar entry\n`);

  const confirmedParams = { takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const allResults = {};

  for (const rMult of R_MULTIPLES) {
    console.log(`========== ${rMult}R ==========`);
    const trades = [];
    for (const z of labeled) {
      const entryPrice = baseCandles[z.entryIdx].o;
      const entryTime = baseCandles[z.entryIdx].t;
      const side = z.side === "bullish" ? "long" : "short";
      const risk = ATR_MULT * z.atrAtSignal;
      const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
      const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;
      const result = simulateFixedR(baseCandles, z.entryIdx, side, stopPrice, targetPrice);
      if (!result) continue;
      const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
      trades.push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, nConfirm: z.nConfirm, win: result.outcome === "target" ? 1 : 0 });
    }
    console.log(`${trades.length} resolved trades, max confirm count present=${Math.max(...trades.map((t) => t.nConfirm), 0)}`);

    const xs = trades.map((t) => t.nConfirm), ys = trades.map((t) => t.win);
    const realR = pointBiserial(xs, ys);
    const gapInfo = topVsBottomGap(xs, ys);
    const rng = mulberry32(SEED);
    let permRGeq = 0, permGapGeq = 0, permGapCount = 0;
    for (let it = 0; it < ITERATIONS; it++) {
      const shuffled = shuffle(xs, rng);
      if (pointBiserial(shuffled, ys) >= realR) permRGeq++;
      const g = topVsBottomGap(shuffled, ys);
      if (g) { permGapCount++; if (g.gap >= gapInfo.gap) permGapGeq++; }
    }
    const pR = permRGeq / ITERATIONS;
    const pGap = gapInfo ? permGapGeq / permGapCount : null;
    console.log(`  correlation r=${realR.toFixed(4)} p=${pR.toFixed(4)}${pR < 0.05 ? "*" : ""}`);
    if (gapInfo) console.log(`  top(${gapInfo.maxX})-vs-bottom(0) gap=${(gapInfo.gap * 100).toFixed(2)}pts (n_top=${gapInfo.nTop}, n_bottom=${gapInfo.nBottom}) p=${pGap.toFixed(4)}${pGap < 0.05 ? "*" : ""}`);

    // Real cost test, matching #27b/#49's two-stage bar: 0-1 confirmations vs 2+ (Python's own "2 of 3" framing).
    function reportBucket(label, bucketTrades) {
      if (bucketTrades.length < 30) { console.log(`  ${label}: n=${bucketTrades.length} (too thin, <30)`); return null; }
      const gross = computeMetrics(bucketTrades);
      const costedTrades = applyCosts(bucketTrades, confirmedParams);
      const grossExp = expectancy(bucketTrades), costedExp = expectancy(costedTrades);
      console.log(`  ${label.padEnd(24)} n=${String(gross.trade_count).padEnd(6)} win=${(gross.win_rate * 100).toFixed(1)}% PF=${gross.profit_factor?.toFixed(2)} gross_exp=${(grossExp * 100).toFixed(4)}%/trade costed_exp=${(costedExp * 100).toFixed(4)}%/trade ${costedExp > 0 ? "(CLEARS COSTS)" : ""}`);
      return { trade_count: gross.trade_count, win_rate: gross.win_rate, profit_factor: gross.profit_factor, gross_expectancy_pct_per_trade: grossExp, costed_expectancy_pct_per_trade: costedExp };
    }
    console.log(`  --- cost/capacity, 0-1 confirm vs 2+ confirm ---`);
    const costResults = {
      low_confirm: reportBucket("0-1 confirm", trades.filter((t) => t.nConfirm <= 1)),
      high_confirm: reportBucket("2+ confirm", trades.filter((t) => t.nConfirm >= 2)),
    };

    allResults[`${rMult}R`] = { tradeCount: trades.length, correlation: { r: realR, p: pR }, topVsBottomGap: gapInfo ? { ...gapInfo, p: pGap } : null, cost: costResults };
    console.log();
  }

  const spanYears = (baseCandles[baseCandles.length - 1].t - baseCandles[0].t) / (365.25 * 86400);
  console.log(`Data span: ${spanYears.toFixed(2)} years. Raw divergence events: ${labeled.length} (${(labeled.length / spanYears).toFixed(1)}/yr).`);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { scope: `Cipher B regular WT divergence, ${BASE_TF}, nested confirmation {15m,4h,1d} (4h substituted for the Python original's 6h)`, results: allResults, dataSpanYears: spanYears, eventCount: labeled.length, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `nested_mtf_divergence_validation_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`Saved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

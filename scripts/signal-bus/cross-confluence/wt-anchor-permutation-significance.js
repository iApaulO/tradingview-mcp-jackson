#!/usr/bin/env node
// Formal permutation significance test on #106 (WT extreme-anchor trade), replacing the flawed
// "win rate vs 50%" test from wt-anchor-trade-significance.js (which tested the wrong tail for a
// sub-50%-win-rate/asymmetric-payoff shape). Same random-direction-null methodology as #99: does
// the anchor's ACTUAL side call beat randomly assigning long/short to the same entries (correctly
// handling that stop/target are asymmetric by side, not a simple sign flip -- precompute both
// scenarios per entry, once, then permute which one applies).
//
// Usage: node scripts/signal-bus/cross-confluence/wt-anchor-permutation-significance.js [--tf=1d,4h,3h,2h,1h,15m] [--r=2] [--iterations=20000]

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeWtExtremeFractals } from "../vmc-cipher-b/calc.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TFS = args.tf ? args.tf.split(",") : ["1d", "4h", "3h", "2h", "1h", "15m"];
const R_MULT = Number(args.r || "2");
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = 42;
const ATR_LEN = 14, ATR_MULT = 0.6, MAX_HOLD_BARS = 200;

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
function simulateSide(candles, entryIdx, side, stopPrice, targetPrice) {
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
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function main() {
  const confirmedParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };

  for (const tf of TFS) {
    const candles = await loadCandles(tf);
    const atr14 = atr(candles, ATR_LEN);
    const { events: anchors } = computeWtExtremeFractals(candles);

    const longScenarios = [], shortScenarios = [];
    for (const a of anchors) {
      const entryIdx = a.barIdx + 1;
      if (entryIdx >= candles.length) continue;
      const atrAtAnchor = atr14[a.barIdx];
      if (!Number.isFinite(atrAtAnchor) || atrAtAnchor <= 0) continue;
      const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
      const risk = ATR_MULT * atrAtAnchor;

      const longStop = entryPrice - risk, longTarget = entryPrice + R_MULT * risk;
      const longRes = simulateSide(candles, entryIdx, "long", longStop, longTarget);
      if (!longRes) continue;
      const longPnl = (longRes.exitPrice - entryPrice) / entryPrice;
      longScenarios.push({ side: "long", entryTime, entryPrice, exitTime: longRes.exitTime, exitPrice: longRes.exitPrice, pnlPct: longPnl });

      const shortStop = entryPrice + risk, shortTarget = entryPrice - R_MULT * risk;
      const shortRes = simulateSide(candles, entryIdx, "short", shortStop, shortTarget);
      if (!shortRes) continue;
      const shortPnl = (entryPrice - shortRes.exitPrice) / entryPrice;
      shortScenarios.push({ side: "short", entryTime, entryPrice, exitTime: shortRes.exitTime, exitPrice: shortRes.exitPrice, pnlPct: shortPnl });
    }
    const n = Math.min(longScenarios.length, shortScenarios.length);
    if (n < 30) { console.log(`${tf}: n=${n}, too thin`); continue; }

    const longCosted = applyCosts(longScenarios.slice(0, n), confirmedParams).map((t) => t.pnlPct);
    const shortCosted = applyCosts(shortScenarios.slice(0, n), confirmedParams).map((t) => t.pnlPct);
    const trueIsLong = anchors.slice(0, n).map((a) => a.side === "bullish");

    const trueVals = new Float64Array(n);
    for (let i = 0; i < n; i++) trueVals[i] = trueIsLong[i] ? longCosted[i] : shortCosted[i];
    const realMean = trueVals.reduce((s, x) => s + x, 0) / n;

    const rng = mulberry32(SEED);
    let geq = 0;
    for (let it = 0; it < ITERATIONS; it++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += rng() < 0.5 ? longCosted[i] : shortCosted[i];
      if (sum / n >= realMean) geq++;
    }
    const p = geq / ITERATIONS;
    console.log(`${tf.padEnd(4)} n=${n}  real costed mean=${(realMean * 100).toFixed(4)}%/trade  vs random-direction null: p=${p.toFixed(4)}${p < 0.05 ? "*" : ""}`);
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

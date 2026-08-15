#!/usr/bin/env node
// Formal significance test on #108 (WT anchor + same-side OB confluence entry, held until the
// opposite-side swing OB's ORIGIN bar -- iapaulo's corrected exit-timing construction). Same
// random-direction-null methodology as #99/#107: does the anchor's ACTUAL side call beat randomly
// assigning long/short to the same entries. Exit mechanics differ by side (opposite-side OB search
// differs, not a simple sign flip), so both scenarios are precomputed once per entry, then permuted.
//
// Usage: node scripts/signal-bus/cross-confluence/wt-anchor-ob-regime-significance.js [--tf=4h,3h,2h,1h,15m] [--iterations=20000]

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeWtExtremeFractals } from "../vmc-cipher-b/calc.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TFS = args.tf ? args.tf.split(",") : ["4h", "3h", "2h", "1h", "15m"];
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
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Simulate one FIXED side's outcome for a fixed entry point (needed for the permutation -- the
// exit's opposing-OB search direction depends on the ASSUMED side, so this must be computed for
// both possible sides at every entry once, not derived by negating one fixed result).
function simulateSideOutcome(candles, entryIdx, side, atrAtAnchor, swingObsBySide, afterBarIdx) {
  const entryPrice = candles[entryIdx].o;
  const risk = ATR_MULT * atrAtAnchor;
  const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
  const oppositeSide = side === "long" ? "bearish" : "bullish";
  const nextOppositeOB = swingObsBySide[oppositeSide].find((ob) => ob.origin_bar_idx > afterBarIdx);
  const naturalExitIdx = Math.min(candles.length - 1, nextOppositeOB ? nextOppositeOB.origin_bar_idx : entryIdx + MAX_HOLD_BARS, entryIdx + MAX_HOLD_BARS);
  if (naturalExitIdx <= entryIdx) return null;
  let exitPrice = candles[naturalExitIdx].c, exitTime = candles[naturalExitIdx].t;
  for (let j = entryIdx; j <= naturalExitIdx; j++) {
    const bar = candles[j];
    const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
    if (hitStop) { exitPrice = stopPrice; exitTime = bar.t; break; }
  }
  const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
  return { side, entryTime: candles[entryIdx].t, entryPrice, exitTime, exitPrice, pnlPct };
}

async function main() {
  const confirmedParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });

  for (const tf of TFS) {
    const candles = await loadCandles(tf);
    const atr14 = atr(candles, ATR_LEN);
    const { events: anchors } = computeWtExtremeFractals(candles);
    const obRows = db.prepare("SELECT side, bar_high, bar_low, created_bar_idx, origin_bar_idx FROM order_blocks WHERE timeframe = ? AND scope = ?").all(tf, "swing");
    const swingObsBySide = {
      bullish: obRows.filter((o) => o.side === "bullish").sort((a, b) => a.origin_bar_idx - b.origin_bar_idx),
      bearish: obRows.filter((o) => o.side === "bearish").sort((a, b) => a.origin_bar_idx - b.origin_bar_idx),
    };

    const longScenarios = [], shortScenarios = [], trueIsLong = [];
    for (const a of anchors) {
      const entryIdx = a.barIdx + 1;
      if (entryIdx >= candles.length) continue;
      const atrAtAnchor = atr14[a.barIdx];
      if (!Number.isFinite(atrAtAnchor) || atrAtAnchor <= 0) continue;
      const hasOB = obRows.some((ob) => ob.side === a.side && ob.created_bar_idx <= a.barIdx + 2 && a.price >= ob.bar_low && a.price <= ob.bar_high);
      if (!hasOB) continue;

      const longRes = simulateSideOutcome(candles, entryIdx, "long", atrAtAnchor, swingObsBySide, a.barIdx);
      const shortRes = simulateSideOutcome(candles, entryIdx, "short", atrAtAnchor, swingObsBySide, a.barIdx);
      if (!longRes || !shortRes) continue;
      longScenarios.push(longRes);
      shortScenarios.push(shortRes);
      trueIsLong.push(a.side === "bullish");
    }
    const n = trueIsLong.length;
    if (n < 30) { console.log(`${tf}: n=${n}, too thin`); continue; }

    const longCosted = applyCosts(longScenarios, confirmedParams).map((t) => t.pnlPct);
    const shortCosted = applyCosts(shortScenarios, confirmedParams).map((t) => t.pnlPct);

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
  db.close();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

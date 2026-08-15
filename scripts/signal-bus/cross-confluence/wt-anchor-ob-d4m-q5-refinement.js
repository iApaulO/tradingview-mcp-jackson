#!/usr/bin/env node
// Refinement test on #108/#109 (WT anchor + same-side OB confluence entry, held to opposing OB's
// origin bar). iapaulo's added description (2026-08-11, bullish 15m example): at the anchor, q5
// should be DROPPING (declining), and the same-side OB should ALSO sit in confluence with a
// same-side ("green"/bullish or "red"/bearish) D4M line, not just the swing line. This is a strict
// ADDITIVE filter on top of the already-validated #108/#109 population -- it never removes or
// changes the baseline construction, only asks whether narrowing to this stricter subset improves
// the edge (per iapaulo: "check for improvement... dont lose what we have").
//
// D4M "line" = a divergence-for-many zone (data/signal-bus/divergence-for-many.db), side
// bullish='green'/bearish='red', active from confirmed_time to expires_time (open-ended if null).
// Confluence tolerance uses 1.2% of price, matching the live-calibrated spread iapaulo confirmed
// against a real chart example (#103 register note: 0.2% was ~5.8x too tight vs an observed ~1.16%
// spread).
//
// Usage: node scripts/signal-bus/cross-confluence/wt-anchor-ob-d4m-q5-refinement.js [--tf=15m] [--q5-lookback=1] [--d4m-tol-pct=0.012]

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeWtExtremeFractals } from "../vmc-cipher-b/calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const D4M_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TF = args.tf || "15m";
const Q5_LOOKBACK = parseInt(args["q5-lookback"] || "1", 10);
const D4M_TOL_PCT = parseFloat(args["d4m-tol-pct"] || "0.012");
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
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function main() {
  const confirmedParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const d4mDb = new DatabaseSync(D4M_DB_PATH, { readOnly: true });

  const candles = await loadCandles(TF);
  const atr14 = atr(candles, ATR_LEN);
  const { events: anchors } = computeWtExtremeFractals(candles);
  const { series } = computeBoomHunter(candles);
  const q5 = series.q5;

  const obRows = smcDb.prepare("SELECT side, bar_high, bar_low, created_bar_idx, origin_bar_idx FROM order_blocks WHERE timeframe = ? AND scope = ?").all(TF, "swing");
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

  function simulate(entryIdx, side, atrAtAnchor, afterBarIdx) {
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

  const baseline = { long: [], short: [] };
  const refined = { long: [], short: [] };
  const refinedScenarios = []; // for significance test: {side, longRes, shortRes}

  for (const a of anchors) {
    const entryIdx = a.barIdx + 1;
    if (entryIdx >= candles.length) continue;
    const atrAtAnchor = atr14[a.barIdx];
    if (!Number.isFinite(atrAtAnchor) || atrAtAnchor <= 0) continue;

    const ob = obRows.find((o) => o.side === a.side && o.created_bar_idx <= a.barIdx + 2 && a.price >= o.bar_low && a.price <= o.bar_high);
    if (!ob) continue;

    const side = a.side === "bullish" ? "long" : "short";
    const baseTrade = simulate(entryIdx, side, atrAtAnchor, a.barIdx);
    if (!baseTrade) continue;
    baseline[side].push(baseTrade);

    // -- additive filters --
    if (a.barIdx - Q5_LOOKBACK < 0) continue;
    const q5Now = q5[a.barIdx], q5Then = q5[a.barIdx - Q5_LOOKBACK];
    if (!Number.isFinite(q5Now) || !Number.isFinite(q5Then)) continue;
    const q5Dropping = q5Now < q5Then;
    if (!q5Dropping) continue;

    const obMidPrice = (ob.bar_high + ob.bar_low) / 2;
    const entryTime = candles[entryIdx].t;
    if (!hasD4mConfluence(a.side, obMidPrice, entryTime)) continue;

    refined[side].push(baseTrade);

    const oppositeSideLong = side === "long" ? "short" : "long";
    const oppRes = simulate(entryIdx, oppositeSideLong, atrAtAnchor, a.barIdx);
    if (!oppRes) continue;
    refinedScenarios.push({ trueIsLong: side === "long", longRes: side === "long" ? baseTrade : oppRes, shortRes: side === "short" ? baseTrade : oppRes });
  }

  smcDb.close();
  d4mDb.close();

  function report(label, trades) {
    if (trades.length === 0) { console.log(`${label}: n=0`); return; }
    const gross = computeMetrics(trades);
    const costed = applyCosts(trades, confirmedParams);
    const exp = expectancy(trades), cexp = expectancy(costed);
    console.log(`${label}: n=${gross.trade_count}  win=${(gross.win_rate * 100).toFixed(1)}%  PF=${gross.profit_factor?.toFixed(2)}  gross_exp=${(exp * 100).toFixed(4)}%/trade  costed_exp=${(cexp * 100).toFixed(4)}%/trade${cexp > 0 ? " (CLEARS)" : ""}`);
  }

  console.log(`\n===== ${TF}: baseline (#108/#109 construction, no q5/D4M filter) =====`);
  report("BULLISH (long)", baseline.long);
  report("BEARISH (short)", baseline.short);

  console.log(`\n===== ${TF}: refined (+ q5 dropping over ${Q5_LOOKBACK} bar(s), + same-side D4M line confluence within ${(D4M_TOL_PCT * 100).toFixed(1)}%) =====`);
  report("BULLISH (long)", refined.long);
  report("BEARISH (short)", refined.short);
  report("POOLED", [...refined.long, ...refined.short]);

  // Formal significance on the refined pooled population (random-direction-null, same methodology as #107/#109)
  const n = refinedScenarios.length;
  if (n >= 30) {
    const longCosted = applyCosts(refinedScenarios.map((s) => s.longRes), confirmedParams).map((t) => t.pnlPct);
    const shortCosted = applyCosts(refinedScenarios.map((s) => s.shortRes), confirmedParams).map((t) => t.pnlPct);
    const trueIsLong = refinedScenarios.map((s) => s.trueIsLong);
    const trueVals = new Float64Array(n);
    for (let i = 0; i < n; i++) trueVals[i] = trueIsLong[i] ? longCosted[i] : shortCosted[i];
    const realMean = trueVals.reduce((s, x) => s + x, 0) / n;
    const ITERATIONS = 20000;
    const rng = mulberry32(42);
    let geq = 0;
    for (let it = 0; it < ITERATIONS; it++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += rng() < 0.5 ? longCosted[i] : shortCosted[i];
      if (sum / n >= realMean) geq++;
    }
    const p = geq / ITERATIONS;
    console.log(`\nRefined pooled significance: n=${n}  real costed mean=${(realMean * 100).toFixed(4)}%/trade  vs random-direction null: p=${p.toFixed(4)}${p < 0.05 ? "*" : ""}`);
  } else {
    console.log(`\nRefined pooled n=${n} -- too thin for a significance test.`);
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

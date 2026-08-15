#!/usr/bin/env node
// Decomposes iapaulo's original 3-part description (2026-08-11: "bullish ob below this price
// extreme = and below swing line and below green d4m line") into its actual constituent filters,
// which #110 never did -- #110 only ever tested OB-confluence + D4M-line, never isolating
// "swing line" (computeSwingPivotSeries) as its own condition (confirmed by code review, register
// #122). Compares three variants head to head on the SAME anchor+OB-confluence+q5-drop base
// population (#108/#109's construction), varying only the structure filter:
//   D4M_ONLY:    same-side D4M-line confluence (current #110/G's actual condition)
//   SWINGLINE_ONLY: OB is beyond the current active swing pivot level (bullish: OB below
//                 swingLowLevel; bearish: OB above swingHighLevel) -- iapaulo's actual described
//                 condition, never built before this
//   BOTH:        the full three-way AND iapaulo originally described, never tested until now
//
// Usage: node scripts/signal-bus/cross-confluence/wt-anchor-swingline-vs-d4m.js [--tf=15m]

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeWtExtremeFractals } from "../vmc-cipher-b/calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { computeSwingPivotSeries } from "../smc/calc.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const D4M_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TF = args.tf || "15m";
const D4M_TOL_PCT = 0.012;
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

async function main() {
  const confirmedParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const d4mDb = new DatabaseSync(D4M_DB_PATH, { readOnly: true });

  const candles = await loadCandles(TF);
  const atr14 = atr(candles, ATR_LEN);
  const { events: anchors } = computeWtExtremeFractals(candles);
  const { series } = computeBoomHunter(candles);
  const q5 = series.q5;
  const { swingHighLevel, swingLowLevel } = computeSwingPivotSeries(candles);

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
  function beyondSwingLine(side, obPrice, barIdx) {
    if (side === "bullish") { const lvl = swingLowLevel[barIdx]; return Number.isFinite(lvl) && obPrice < lvl; }
    const lvl = swingHighLevel[barIdx]; return Number.isFinite(lvl) && obPrice > lvl;
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

  const variants = { D4M_ONLY: [], SWINGLINE_ONLY: [], BOTH: [] };

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

    const entryIdxLocal = entryIdx;
    const side = a.side === "bullish" ? "long" : "short";
    const trade = simulate(entryIdxLocal, side, atrAtAnchor, a.barIdx);
    if (!trade) continue;

    const obMidPrice = (ob.bar_high + ob.bar_low) / 2;
    const entryTime = candles[entryIdxLocal].t;
    const hasD4m = hasD4mConfluence(a.side, obMidPrice, entryTime);
    const hasSwingLine = beyondSwingLine(a.side, obMidPrice, a.barIdx);

    if (hasD4m) variants.D4M_ONLY.push(trade);
    if (hasSwingLine) variants.SWINGLINE_ONLY.push(trade);
    if (hasD4m && hasSwingLine) variants.BOTH.push(trade);
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

  console.log(`\n===== ${TF}: swing-line vs D4M-line as the structure filter (base pop: anchor + OB-confluence + q5-drop) =====`);
  report("D4M_ONLY   (current #110/G condition)", variants.D4M_ONLY);
  report("SWINGLINE_ONLY (iapaulo's actual described condition, never built before)", variants.SWINGLINE_ONLY);
  report("BOTH       (full 3-way AND iapaulo originally described)", variants.BOTH);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

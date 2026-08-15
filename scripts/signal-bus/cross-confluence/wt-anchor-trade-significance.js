#!/usr/bin/env node
// Trade construction on the WT extreme-fractal anchor (computeWtExtremeFractals, added 2026-08-11),
// which just showed a real, well-replicated 73-84% wave-2 confirmation rate across all 8
// timeframes. This tests trading the ANCHOR itself (entering before wave 2 confirms, anticipating
// it, per iapaulo's own framing), not waiting for the already-tested full divergence.
//
// Two exit constructions compared directly:
//   A) Fixed-R (house standard): 0.6xATR(14) stop, R-multiple target, race-to-target-or-stop.
//   B) Wave-2-exit: same 0.6xATR(14) stop, but NO fixed target -- exit when a same-side wave-2
//      divergence actually confirms (the anchor's own predicted event), or timeout at 90 bars if it
//      never does. This is the literal, direct trade version of "the anchor predicts wave 2."
//
// Usage: node scripts/signal-bus/cross-confluence/wt-anchor-trade-significance.js [--tf=1w,1d,4h,...] [--r=1,1.5,2,3]

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeWtExtremeFractals, computeRegularDivergenceUnion } from "../vmc-cipher-b/calc.js";

const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TFS = args.tf ? args.tf.split(",") : LADDER_KEYS;
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const ATR_LEN = 14, ATR_MULT = 0.6, MAX_HOLD_BARS = 200, WAVE2_TIMEOUT_BARS = 90;

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
function simulateWave2Exit(candles, entryIdx, side, stopPrice, wave2ExitIdx) {
  const cap = Math.min(candles.length - 1, entryIdx + WAVE2_TIMEOUT_BARS, wave2ExitIdx ?? Infinity);
  for (let j = entryIdx; j <= cap; j++) {
    const bar = candles[j];
    const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
    if (hitStop) return { exitPrice: stopPrice, exitTime: bar.t };
  }
  const exitIdx = Math.min(candles.length - 1, cap);
  return { exitPrice: candles[exitIdx].c, exitTime: candles[exitIdx].t };
}
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }
function winRate(vals) { return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null; }
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(arr, rng) { const out = [...arr]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; }
function oneSampleSignTest(wins, iterations, seed) {
  const realWinRate = winRate(wins);
  const rng = mulberry32(seed);
  let geq = 0;
  for (let it = 0; it < iterations; it++) {
    let s = 0;
    for (let i = 0; i < wins.length; i++) s += rng() < 0.5 ? 1 : 0;
    if (s / wins.length >= realWinRate) geq++;
  }
  return { realWinRate, p: geq / iterations };
}

async function main() {
  const confirmedParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };

  for (const tf of TFS) {
    const candles = await loadCandles(tf);
    const atr14 = atr(candles, ATR_LEN);
    const { events: anchors } = computeWtExtremeFractals(candles);
    const { zones: divs } = computeRegularDivergenceUnion(candles);

    console.log(`\n========================= ${tf} (${anchors.length} anchors) =========================`);

    // --- Construction B: wave-2-exit, no fixed target ---
    const b_trades = [];
    for (const a of anchors) {
      const entryIdx = a.barIdx + 1;
      if (entryIdx >= candles.length) continue;
      const atrAtAnchor = atr14[a.barIdx];
      if (!Number.isFinite(atrAtAnchor) || atrAtAnchor <= 0) continue;
      const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
      const side = a.side === "bullish" ? "long" : "short";
      const risk = ATR_MULT * atrAtAnchor;
      const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
      const wave2 = divs.find((d) => d.side === a.side && d.confirmedBarIdx > a.barIdx && d.confirmedBarIdx <= a.barIdx + WAVE2_TIMEOUT_BARS);
      const result = simulateWave2Exit(candles, entryIdx, side, stopPrice, wave2?.confirmedBarIdx);
      const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
      b_trades.push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, win: pnlPct > 0 ? 1 : 0 });
    }
    if (b_trades.length >= 30) {
      const gross = computeMetrics(b_trades);
      const costed = applyCosts(b_trades, confirmedParams);
      const sig = oneSampleSignTest(b_trades.map((t) => t.win), 20000, 42);
      console.log(`  [B: wave-2-exit] n=${b_trades.length} win=${(gross.win_rate * 100).toFixed(1)}% (vs random p=${sig.p.toFixed(4)}${sig.p < 0.05 ? "*" : ""}) PF=${gross.profit_factor?.toFixed(2)} gross_exp=${(expectancy(b_trades) * 100).toFixed(4)}%/trade costed_exp=${(expectancy(costed) * 100).toFixed(4)}%/trade ${expectancy(costed) > 0 ? "(CLEARS COSTS)" : ""}`);
    } else console.log(`  [B: wave-2-exit] n=${b_trades.length} (too thin)`);

    // --- Construction A: fixed-R ---
    for (const rMult of R_MULTIPLES) {
      const a_trades = [];
      for (const a of anchors) {
        const entryIdx = a.barIdx + 1;
        if (entryIdx >= candles.length) continue;
        const atrAtAnchor = atr14[a.barIdx];
        if (!Number.isFinite(atrAtAnchor) || atrAtAnchor <= 0) continue;
        const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
        const side = a.side === "bullish" ? "long" : "short";
        const risk = ATR_MULT * atrAtAnchor;
        const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
        const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;
        const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
        if (!result) continue;
        const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
        a_trades.push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, win: result.exitPrice === targetPrice ? 1 : 0 });
      }
      if (a_trades.length < 30) { console.log(`  [A: ${rMult}R] n=${a_trades.length} (too thin)`); continue; }
      const gross = computeMetrics(a_trades);
      const costed = applyCosts(a_trades, confirmedParams);
      console.log(`  [A: ${rMult}R]        n=${a_trades.length} win=${(gross.win_rate * 100).toFixed(1)}% PF=${gross.profit_factor?.toFixed(2)} gross_exp=${(expectancy(a_trades) * 100).toFixed(4)}%/trade costed_exp=${(expectancy(costed) * 100).toFixed(4)}%/trade ${expectancy(costed) > 0 ? "(CLEARS COSTS)" : ""}`);
    }
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

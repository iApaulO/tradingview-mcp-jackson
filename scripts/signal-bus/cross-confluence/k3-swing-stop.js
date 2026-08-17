#!/usr/bin/env node
// K>=3 WITH STRUCTURAL (SWING) STOPS versus ATR STOPS -- a correction I should have applied long ago.
//
// **#94 already established this, on iapaulo's own correction: "stop at the PREVIOUS swing LOW for a
// long, previous swing HIGH for a short -- the structural invalidation level, not an ATR-based
// volatility band."** The machinery has existed since then -- `computeSwingPivotSeries` exposing
// `swingLowLevel` / `swingHighLevel` per bar, and a `--stop-mode=swing` flag on the Strategy E
// significance script.
//
// **It was only ever wired into Strategy E.** K>=3 has used a 2.0x ATR(14) stop throughout -- #138's
// stop-width sweep, #140-#142's robustness work, and #143's FROZEN PRE-REGISTRATION -- and so did
// every candidate tested on 2026-08-16/17 (#155, #162, #165, #169, #171). If the structural stop is
// the right risk unit for this methodology, then all of that measured the wrong geometry.
//
// WHY IT PLAUSIBLY MATTERS, stated as a mechanism rather than a hope:
//   * An ATR stop is a VOLATILITY band and is placed without reference to structure. It can sit in
//     the middle of a range, or just inside a swing that would have held, so a setup that was never
//     actually invalidated gets stopped out.
//   * A swing stop is the level at which the SETUP IS WRONG. For an SMC construction whose entry
//     logic is entirely structural, matching the exit geometry to the same structure is the
//     internally consistent choice.
//   * R itself changes meaning: with a structural stop, 1R is "the distance to invalidation", so a
//     2R target is a statement about structure rather than about volatility.
//
// WHAT THIS RUN IS AND IS NOT. It is a like-for-like comparison on the SAME cluster population, with
// only the stop construction changed. It is NOT a new pre-registration and does not re-open #143's
// gate: #143 froze the ATR construction and passed on SOL, and that result stands for the geometry
// it tested. If the swing construction is better, the honest consequence is a NEW pre-registration
// of the swing variant, not a retroactive re-labelling of #143.
//
// Target is R_MULT x the structural risk. A trade whose swing level sits on the wrong side of entry
// (stop above entry for a long) is DISCARDED, not clamped -- clamping would silently substitute a
// different construction for the one being tested.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { loadStructureEvents, buildCooccurrenceClusters } from "./lib/cooccurrence.js";
import { computeSwingPivotSeries } from "../smc/calc.js";

const CLUSTER_MULT = 1, ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_K = 3;

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}

// One trade, given an explicit stop distance. Slippage stays ATR-scaled in both modes: it models
// execution friction, which is a volatility property and has nothing to do with where the stop sits.
function runTrade(c, atr, idx, side, stopPrice) {
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(stopPrice)) return null;
  const entry = side === "long" ? c[idx].o + SLIP_ENTRY_ATR * a : c[idx].o - SLIP_ENTRY_ATR * a;
  const risk = side === "long" ? entry - stopPrice : stopPrice - entry;
  if (!(risk > 0)) return null;                       // structural level on the wrong side: discard
  const tgt = side === "long" ? entry + R_MULT * risk : entry - R_MULT * risk;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  let pnl = null, hours = 0, won = 0;
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    const hs = side === "long" ? b.l <= stopPrice : b.h >= stopPrice;
    const ht = side === "long" ? b.h >= tgt : b.l <= tgt;
    if (hs) { const f = side === "long" ? stopPrice - SLIP_STOP_ATR * a : stopPrice + SLIP_STOP_ATR * a;
      pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry; hours = (b.t - c[idx].t) / 3600; won = 0; break; }
    if (ht) { const f = side === "long" ? tgt - SLIP_TARGET_ATR * a : tgt + SLIP_TARGET_ATR * a;
      pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry; hours = (b.t - c[idx].t) / 3600; won = 1; break; }
  }
  if (pnl === null) {
    if (end <= idx) return null;
    const b = c[end];
    const f = side === "long" ? b.c - SLIP_ENTRY_ATR * a : b.c + SLIP_ENTRY_ATR * a;
    pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry;
    hours = (b.t - c[idx].t) / 3600; won = pnl > 0 ? 1 : 0;
  }
  return { net: pnl - 2 * TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, hours), won, riskPct: risk / entry };
}

async function main() {
  console.log("K>=3 -- STRUCTURAL (SWING) STOP versus ATR STOP, like-for-like on the same clusters.");
  console.log("#94 established the swing stop on iapaulo's correction; it was only ever wired into Strategy E.");
  console.log(`Both modes: ${R_MULT}R target, hold<=${HOLD_BARS}, stop-first, MTM, slip ${SLIP_ENTRY_ATR}/${SLIP_STOP_ATR} ATR, taker+funding.`);
  console.log("Only the STOP construction differs. 2R breakeven is 33.3% before costs.\n");

  console.log("inst   mode      n    discarded   win%      net%/trade    mean risk%   median hold(h)");
  for (const inst of ["BTC", "ETH", "SOL"]) {
    const clusters = buildCooccurrenceClusters(loadStructureEvents(inst), { mult: CLUSTER_MULT }).filter((c) => c.K >= MIN_K);
    const byRung = new Map();
    for (const c of clusters) { if (!byRung.has(c.outcomeRung)) byRung.set(c.outcomeRung, []); byRung.get(c.outcomeRung).push(c); }

    const out = { atr: [], swing: [] };
    const dropped = { atr: 0, swing: 0 };
    for (const [rung, list] of byRung) {
      const c = await loadCandles(rung, inst);
      const atr = atrSeries(c, ATR_LEN);
      const piv = computeSwingPivotSeries(c);
      const times = c.map((x) => x.t);
      for (const cl of list) {
        let lo = 0, hi = times.length - 1, idx = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] > cl.knownAtTime) { idx = m; hi = m - 1; } else lo = m + 1; }
        if (idx < 0 || idx >= c.length) continue;
        const a = atr[idx];
        if (!Number.isFinite(a) || a <= 0) continue;
        const side = cl.direction === "bullish" ? "long" : "short";
        const entryApprox = c[idx].o;

        const atrStop = side === "long" ? entryApprox - ATR_MULT * a : entryApprox + ATR_MULT * a;
        const tA = runTrade(c, atr, idx, side, atrStop);
        if (tA) out.atr.push(tA); else dropped.atr++;

        // structural level as it stood at the bar BEFORE entry -- available_at, no lookahead
        const sw = side === "long" ? piv.swingLowLevel[idx - 1] : piv.swingHighLevel[idx - 1];
        const tS = runTrade(c, atr, idx, side, sw);
        if (tS) out.swing.push(tS); else dropped.swing++;
      }
    }
    for (const mode of ["atr", "swing"]) {
      const g = out[mode];
      if (!g.length) { console.log(`${inst.padEnd(6)}${mode.padEnd(8)} none`); continue; }
      console.log(
        `${inst.padEnd(6)}${mode.padEnd(8)}${String(g.length).padStart(5)}${String(dropped[mode]).padStart(12)}` +
        `${(g.filter((t) => t.won).length / g.length * 100).toFixed(1).padStart(9)}%` +
        `${(mean(g.map((t) => t.net)) * 100).toFixed(4).padStart(14)}%` +
        `${(mean(g.map((t) => t.riskPct)) * 100).toFixed(3).padStart(13)}%`,
      );
    }
    console.log("");
  }
  console.log("A trade whose structural level sits on the wrong side of entry is DISCARDED, not clamped --");
  console.log("clamping would substitute a different construction for the one under test.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });

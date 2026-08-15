#!/usr/bin/env node
// Does agreement depth D gate Strategy G?
//
// SETUP. #132 found that D -- the number of consecutive rungs from the weekly down that share the
// weekly's SuperTrend direction -- carries significant information (pooled I(Y;D)=0.000374 bits,
// p=0.0250) where no individual rung's direction did, and that the relationship runs the
// counter-intuitive way: FULL ladder agreement (D=8) has the best win rate and the WORST
// expectancy, while shallow-disagreement states (D=1, boundary at the daily) carry the positive
// means. That is independently the same shape as #113/#114, which found Strategy G fires AGAINST
// the concurrent daily regime and performs no better than chance when aligned with it.
//
// #132's own effect is sub-cost standalone (means spanning -0.06% to +0.05% against a 0.10% round
// trip), so the only place a signal that small can matter is as a FILTER on an edge that already
// clears costs. G clears costs (#110/#125: ~+0.28%/trade costed at 15m). Hence this test.
//
// D is also a strictly RICHER regime encoding than the binary daily state G currently uses, so
// this asks a sharper question than #113 did: not "does the daily regime matter" but "does knowing
// WHERE the ladder breaks matter more than knowing what the daily is doing".
//
// CONSTRUCTION. G's trade population is built exactly as in wt-anchor-swingline-vs-d4m.js (#123) --
// WT2 extreme anchor + same-side SMC swing order-block confluence + Boom Hunter q5 dropping, held
// to the opposite-side OB's origin bar with a 0.6xATR stop. Three structure-filter variants are
// carried through because #126 showed they differ materially: D4M_ONLY (G's shipped condition),
// SWINGLINE_ONLY (the one #126 found actually carries the effect), and BOTH.
//
// AVAILABLE_AT. D at entry uses, for every rung, only that rung's last bar CLOSED at or before the
// entry bar's open. A gate computed from a rung bar that had not yet closed would be exactly the
// look-ahead this project has shipped twice.
//
// NULL. Trades are discrete events, so per #129 a label permutation is defensible -- but #129 also
// showed thin cells are block-size sensitive, so both an i.i.d. permutation and a circular shift
// over TIME-ORDERED trades are reported. Where they disagree, trust the circular one.
//
// Usage: node scripts/signal-bus/cross-confluence/strategy-g-depth-gate.js
//        [--instrument=BTC] [--tf=15m] [--iterations=20000]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { calcATRSeries, computeAdaptiveSuperTrend } from "../../lib/adaptive-supertrend.js";
import { computeWtExtremeFractals } from "../vmc-cipher-b/calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { computeSwingPivotSeries } from "../smc/calc.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const INSTRUMENT = args.instrument || "BTC";
const TF = args.tf || "15m";
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const D4M_TOL_PCT = 0.012, ATR_LEN = 14, ATR_MULT = 0.6, MAX_HOLD_BARS = 200, ST_ATR_LEN = 10;
const LADDER = [["1w", 604800], ["1d", 86400], ["4h", 14400], ["3h", 10800], ["2h", 7200], ["1h", 3600], ["15m", 900], ["5m", 300]];

const smcPath = new URL(`../../../data/signal-bus/${INSTRUMENT === "BTC" ? "smc.db" : "smc-eth.db"}`, import.meta.url);
const d4mPath = new URL(`../../../data/signal-bus/${INSTRUMENT === "BTC" ? "divergence-for-many.db" : "divergence-for-many-eth.db"}`, import.meta.url);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
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
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

async function main() {
  const costParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const candles = await loadCandles(TF, INSTRUMENT);
  const atr14 = atr(candles, ATR_LEN);
  const { events: anchors } = computeWtExtremeFractals(candles);
  const { series } = computeBoomHunter(candles);
  const q5 = series.q5;
  const { swingHighLevel, swingLowLevel } = computeSwingPivotSeries(candles);

  // ── D at every base bar, available_at enforced ──────────────────────────────────────────
  const nB = candles.length;
  const dirs = [];
  for (const [tf, stepSec] of LADDER) {
    const c = tf === TF ? candles : await loadCandles(tf, INSTRUMENT);
    const { dir } = computeAdaptiveSuperTrend(c, calcATRSeries(c, ST_ATR_LEN));
    const s = new Int8Array(nB).fill(-1);
    let j = 0;
    for (let i = 0; i < nB; i++) {
      const cutoff = candles[i].t - stepSec;
      while (j + 1 < c.length && c[j + 1].t <= cutoff) j++;
      if (c[j].t <= cutoff && Number.isFinite(dir[j])) s[i] = dir[j] > 0 ? 1 : 0;
    }
    dirs.push(s);
  }
  const Darr = new Int8Array(nB).fill(-1), topArr = new Int8Array(nB).fill(-1), dailyArr = new Int8Array(nB).fill(-1);
  for (let i = 0; i < nB; i++) {
    let ok = true;
    for (const s of dirs) if (s[i] < 0) { ok = false; break; }
    if (!ok) continue;
    topArr[i] = dirs[0][i];
    dailyArr[i] = dirs[1][i];
    let d = 0;
    while (d < dirs.length && dirs[d][i] === topArr[i]) d++;
    Darr[i] = d;
  }

  // ── G's population, verbatim from #123 ──────────────────────────────────────────────────
  const smcDb = new DatabaseSync(smcPath, { readOnly: true });
  const d4mDb = new DatabaseSync(d4mPath, { readOnly: true });
  const obRows = smcDb.prepare("SELECT side, bar_high, bar_low, created_bar_idx, origin_bar_idx FROM order_blocks WHERE timeframe = ? AND scope = ?").all(TF, "swing");
  const swingObsBySide = {
    bullish: obRows.filter((o) => o.side === "bullish").sort((a, b) => a.origin_bar_idx - b.origin_bar_idx),
    bearish: obRows.filter((o) => o.side === "bearish").sort((a, b) => a.origin_bar_idx - b.origin_bar_idx),
  };
  const d4mZones = d4mDb.prepare("SELECT side, price, confirmed_time, expires_time FROM zones").all();
  smcDb.close(); d4mDb.close();

  function hasD4m(side, obPrice, atTime) {
    const tol = obPrice * D4M_TOL_PCT;
    for (const z of d4mZones) {
      if (z.side !== side) continue;
      if (z.confirmed_time > atTime) continue;
      if (z.expires_time != null && z.expires_time < atTime) continue;
      if (Math.abs(z.price - obPrice) <= tol) return true;
    }
    return false;
  }
  function beyondSwing(side, obPrice, barIdx) {
    if (side === "bullish") { const l = swingLowLevel[barIdx]; return Number.isFinite(l) && obPrice < l; }
    const h = swingHighLevel[barIdx]; return Number.isFinite(h) && obPrice > h;
  }
  function simulate(entryIdx, side, atrAtAnchor, afterBarIdx) {
    const entryPrice = candles[entryIdx].o;
    const risk = ATR_MULT * atrAtAnchor;
    const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
    const opp = side === "long" ? "bearish" : "bullish";
    const nextOpp = swingObsBySide[opp].find((ob) => ob.origin_bar_idx > afterBarIdx);
    const exitIdx = Math.min(candles.length - 1, nextOpp ? nextOpp.origin_bar_idx : entryIdx + MAX_HOLD_BARS, entryIdx + MAX_HOLD_BARS);
    if (exitIdx <= entryIdx) return null;
    let exitPrice = candles[exitIdx].c, exitTime = candles[exitIdx].t;
    for (let j = entryIdx; j <= exitIdx; j++) {
      const bar = candles[j];
      if (side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice) { exitPrice = stopPrice; exitTime = bar.t; break; }
    }
    const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
    return { side, entryTime: candles[entryIdx].t, entryPrice, exitTime, exitPrice, pnlPct };
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
    if (Darr[entryIdx] < 0) continue; // gate undefined -> excluded from every variant equally
    const side = a.side === "bullish" ? "long" : "short";
    const t = simulate(entryIdx, side, atrAtAnchor, a.barIdx);
    if (!t) continue;
    const obMid = (ob.bar_high + ob.bar_low) / 2;
    const entryTime = candles[entryIdx].t;
    trades.push({
      ...t,
      D: Darr[entryIdx],
      // Does the trade's own side agree with the weekly / with the daily?
      agreesWeekly: (a.side === "bullish") === (topArr[entryIdx] === 1),
      agreesDaily: (a.side === "bullish") === (dailyArr[entryIdx] === 1),
      hasD4m: hasD4m(a.side, obMid, entryTime),
      hasSwing: beyondSwing(a.side, obMid, a.barIdx),
    });
  }

  const VARIANTS = {
    "D4M_ONLY (shipped G)": (t) => t.hasD4m,
    "SWINGLINE_ONLY": (t) => t.hasSwing,
    "BOTH": (t) => t.hasD4m && t.hasSwing,
  };

  const out = { instrument: INSTRUMENT, timeframe: TF, iterations: ITERATIONS, variants: {} };
  console.log(`\n${"=".repeat(104)}`);
  console.log(`STRATEGY G x AGREEMENT DEPTH D -- ${INSTRUMENT} ${TF}, costed at bitunix_futures_vip1`);
  console.log(`${"=".repeat(104)}`);

  for (const [vname, pred] of Object.entries(VARIANTS)) {
    const sub = trades.filter(pred).sort((a, b) => a.entryTime - b.entryTime);
    if (sub.length < 50) { console.log(`\n${vname}: n=${sub.length}, too thin`); continue; }
    const costed = applyCosts(sub, costParams).map((t) => t.pnlPct);
    const overall = mean(costed);

    console.log(`\n--- ${vname}  (n=${sub.length}, ungated costed expectancy ${(overall * 100).toFixed(4)}%/trade) ---`);
    console.log(`  D      n      costed%/tr   win%     vs ungated`);
    const byD = {};
    for (let d = 1; d <= 8; d++) {
      const ids = sub.map((t, i) => (t.D === d ? i : -1)).filter((i) => i >= 0);
      if (ids.length === 0) continue;
      const m = mean(ids.map((i) => costed[i]));
      const w = ids.reduce((s, i) => s + (costed[i] > 0 ? 1 : 0), 0) / ids.length;
      byD[d] = { n: ids.length, costed_pct: m * 100, win: w };
      console.log(`  ${d}  ${String(ids.length).padStart(6)}   ${(m * 100).toFixed(4).padStart(10)}%  ${(w * 100).toFixed(1).padStart(5)}%   ${((m - overall) * 100 >= 0 ? "+" : "")}${((m - overall) * 100).toFixed(4)}pp`);
    }

    // Disagreement (shallow D) vs agreement (deep D). Split at the midpoint of the ladder.
    const shallow = sub.map((t, i) => (t.D <= 2 ? i : -1)).filter((i) => i >= 0);
    const deep = sub.map((t, i) => (t.D >= 7 ? i : -1)).filter((i) => i >= 0);
    const mShallow = mean(shallow.map((i) => costed[i])), mDeep = mean(deep.map((i) => costed[i]));
    console.log(`  shallow D<=2 (ladder breaks early): n=${shallow.length} costed=${(mShallow * 100).toFixed(4)}%`);
    console.log(`  deep    D>=7 (ladder mostly agrees): n=${deep.length} costed=${(mDeep * 100).toFixed(4)}%`);
    const realGap = mShallow - mDeep;
    console.log(`  gap (shallow - deep) = ${(realGap * 100).toFixed(4)}pp`);

    // Nulls: i.i.d. label permutation and circular shift over time-ordered trades (#129).
    const labels = sub.map((t) => (t.D <= 2 ? 1 : t.D >= 7 ? 0 : -1));
    const elig = labels.map((l, i) => (l >= 0 ? i : -1)).filter((i) => i >= 0);
    function gapFrom(assign) {
      let sA = 0, nA = 0, sB = 0, nB2 = 0;
      for (let k = 0; k < elig.length; k++) {
        const i = elig[k];
        if (assign[k] === 1) { sA += costed[i]; nA++; } else { sB += costed[i]; nB2++; }
      }
      return nA && nB2 ? sA / nA - sB / nB2 : null;
    }
    const eligLabels = elig.map((i) => labels[i]);
    const rngA = mulberry32(SEED), rngB = mulberry32(SEED + 7);
    let geqI = 0, geqC = 0;
    for (let k = 0; k < ITERATIONS; k++) {
      const sh = [...eligLabels];
      for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rngA() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
      const g = gapFrom(sh);
      if (g != null && g >= realGap) geqI++;
      const off = 1 + Math.floor(rngB() * (eligLabels.length - 2));
      const cs = eligLabels.map((_, i) => eligLabels[(i + off) % eligLabels.length]);
      const g2 = gapFrom(cs);
      if (g2 != null && g2 >= realGap) geqC++;
    }
    const pI = geqI / ITERATIONS, pC = geqC / ITERATIONS;
    console.log(`  p(iid)=${pI.toFixed(4)}${pI < 0.05 ? "*" : ""}   p(circular)=${pC.toFixed(4)}${pC < 0.05 ? "*" : ""}`);

    // ── Side-alignment splits, each significance-tested rather than left descriptive ────────
    // A descriptive gap is not a finding in this register; #126's whole lesson was that a
    // higher mean on a smaller subset is what sampling noise produces for free.
    function splitTest(label, predicate) {
      const a = sub.map((t, i) => (predicate(t) ? i : -1)).filter((i) => i >= 0);
      const b = sub.map((t, i) => (!predicate(t) ? i : -1)).filter((i) => i >= 0);
      if (a.length < 30 || b.length < 30) { console.log(`  ${label}: too thin`); return null; }
      const mA = mean(a.map((i) => costed[i])), mB = mean(b.map((i) => costed[i]));
      const gap = mA - mB;
      const lab = sub.map((t) => (predicate(t) ? 1 : 0));
      const rA = mulberry32(SEED + 11), rB = mulberry32(SEED + 13);
      let gI = 0, gC = 0;
      const gapFromLabels = (arr) => {
        let sA = 0, nA = 0, sB = 0, nB2 = 0;
        for (let i = 0; i < arr.length; i++) { if (arr[i]) { sA += costed[i]; nA++; } else { sB += costed[i]; nB2++; } }
        return nA && nB2 ? sA / nA - sB / nB2 : null;
      };
      for (let k = 0; k < ITERATIONS; k++) {
        const sh = [...lab];
        for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rA() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
        const g = gapFromLabels(sh);
        if (g != null && g >= gap) gI++;
        const off = 1 + Math.floor(rB() * (lab.length - 2));
        const cs = lab.map((_, i) => lab[(i + off) % lab.length]);
        const g2 = gapFromLabels(cs);
        if (g2 != null && g2 >= gap) gC++;
      }
      const pi = gI / ITERATIONS, pc = gC / ITERATIONS;
      console.log(`  ${label.padEnd(22)} TRUE n=${String(a.length).padStart(4)} ${(mA * 100).toFixed(4)}%  |  FALSE n=${String(b.length).padStart(4)} ${(mB * 100).toFixed(4)}%  |  gap=${(gap * 100).toFixed(4)}pp  p(iid)=${pi.toFixed(4)}${pi < 0.05 ? "*" : ""} p(circ)=${pc.toFixed(4)}${pc < 0.05 ? "*" : ""}`);
      return { true_n: a.length, true_pct: mA * 100, false_n: b.length, false_pct: mB * 100, gap_pp: gap * 100, p_iid: pi, p_circular: pc };
    }
    console.log(`  --- side-alignment splits (significance-tested) ---`);
    const opposesWeekly = splitTest("opposes WEEKLY", (t) => !t.agreesWeekly);
    const opposesDaily = splitTest("opposes DAILY", (t) => !t.agreesDaily);

    // Are these the same split wearing two hats? #113/#114 already established G is counter-DAILY,
    // so a counter-WEEKLY result is only NEW to the extent the two labels differ.
    let agreeFrac = null;
    {
      let same = 0;
      for (const t of sub) if (t.agreesWeekly === t.agreesDaily) same++;
      agreeFrac = same / sub.length;
      console.log(`  weekly-alignment and daily-alignment labels agree on ${(agreeFrac * 100).toFixed(1)}% of trades -- the counter-weekly result is new only insofar as this is below 100%`);
    }

    out.variants[vname] = { n: sub.length, ungated_costed_pct: overall * 100, byD, shallow_n: shallow.length, shallow_pct: mShallow * 100, deep_n: deep.length, deep_pct: mDeep * 100, gap_pp: realGap * 100, p_iid: pI, p_circular: pC, opposes_weekly: opposesWeekly, opposes_daily: opposesDaily, weekly_daily_label_overlap: agreeFrac };
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `strategy_g_depth_gate_${INSTRUMENT}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify({ generated_at: new Date().toISOString(), ...out }, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

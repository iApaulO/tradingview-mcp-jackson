#!/usr/bin/env node
// WICK-BREAK vs CLOSE-BREAK STRUCTURE — testing a mechanical difference sourced from outside.
//
// PROVENANCE: iapaulo supplied a Photon Trading "Mechanical Market Structure" lesson page. Its
// mechanics differ from our port in one implementable way: it defines THREE structure layers, and
// its FRACTAL layer confirms on a WICK BREAK where Swing and Internal confirm on a CANDLE BODY
// CLOSE. `smc/calc.js:271` uses close-based breaks only (`candles[i].c > highPivot.currentLevel`),
// so the wick variant has never existed here.
//
// **TWO REFERENT WARNINGS, because the vocabulary collides and that has cost this project before
// (#157, #169):**
//   * Their CHoCH is a WICK penetration of fractal structure marking an internal pullback. Ours is
//     a BODY CLOSE that flips trend bias. SAME WORD, DIFFERENT OBJECT.
//   * Their strong/weak high is "caused the opposing swing, sharp move away, larger candles". Ours
//     is LuxAlgo's `swingTrend.bias`. SAME WORD, DIFFERENT OBJECT.
// Nothing here assumes the two vocabularies agree. Only the wick-vs-close mechanic is transferred,
// because it is the one part that is unambiguous and codeable.
//
// WHY TEST IT ON THE REGIME GATE. #224 established the project's most durable pattern: every
// construction that survived anything has a REGIME GATE in it, every pure-level construction failed.
// The gate is `swingBias == BULLISH`, and swingBias is produced by exactly the break rule under test.
// If wick-breaks flip the regime earlier or more often, the gate changes -- and the gate is the part
// that works. That makes this the highest-value place to test the difference.
//
// Both bias series are computed from the SAME pivot detection so the ONLY difference is the break
// trigger. Then the #211/#212 construction (bullish OB inside Strong Low, 4h, 2R maker) is run under
// each, against the same-side random null (#210), per-rung, with cluster t (#204).

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "./calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const SWING_LEN = 50, MIN_N = 60, SEEDS = 300, BULL = 1, BEAR = -1;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;
const INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "LTC", "LINK", "XLM"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const tOf = (xs) => { if (xs.length < 2) return NaN; const s = sd(xs) * Math.sqrt(xs.length / (xs.length - 1)); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN; };
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}
const fund = (c, i, j) => REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, (c[j].t - c[i].t) / 3600);

/**
 * Swing-scope trend bias under a chosen break trigger.
 * mode "close" reproduces calc.js:271. mode "wick" substitutes high/low for the close.
 * Pivot detection is identical in both, so the trigger is the only difference.
 */
function biasSeries(c, mode) {
  const n = c.length;
  const bias = new Array(n).fill(0);
  let cur = 0;
  let hiLvl = NaN, hiCrossed = true, loLvl = NaN, loCrossed = true;

  for (let i = 0; i < n; i++) {
    // confirmed swing pivots, SWING_LEN lookback each side (LuxAlgo swing scope)
    const p = i - SWING_LEN;
    if (p >= SWING_LEN) {
      let isH = true, isL = true;
      for (let k = p - SWING_LEN; k <= p + SWING_LEN; k++) {
        if (k === p || k < 0 || k >= n) continue;
        if (c[k].h >= c[p].h) isH = false;
        if (c[k].l <= c[p].l) isL = false;
      }
      if (isH) { hiLvl = c[p].h; hiCrossed = false; }
      if (isL) { loLvl = c[p].l; loCrossed = false; }
    }
    if (i > 0) {
      const upNow = mode === "close" ? c[i].c : c[i].h;
      const upPrev = mode === "close" ? c[i - 1].c : c[i - 1].h;
      const dnNow = mode === "close" ? c[i].c : c[i].l;
      const dnPrev = mode === "close" ? c[i - 1].c : c[i - 1].l;
      if (!Number.isNaN(hiLvl) && !hiCrossed && upNow > hiLvl && upPrev <= hiLvl) { hiCrossed = true; cur = BULL; }
      if (!Number.isNaN(loLvl) && !loCrossed && dnNow < loLvl && dnPrev >= loLvl) { loCrossed = true; cur = BEAR; }
    }
    bias[i] = cur;
  }
  return bias;
}

function trade(c, atr, idx) {
  if (idx >= c.length) return null;
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0) return null;
  const e = c[idx].o, st = e - ATR_MULT * a, tg = e + R_MULT * ATR_MULT * a;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    if (b.l <= st) return { net: (st - SLIP_STOP_ATR * a - e) / e - MAKER - TAKER - fund(c, idx, j), won: 0, entry: idx, exit: j };
    if (b.h >= tg) return { net: (tg - e) / e - 2 * MAKER - fund(c, idx, j), won: 1, entry: idx, exit: j };
  }
  if (end < idx + HOLD_BARS) return null;
  const raw = (c[end].c - e) / e;
  return { net: raw - MAKER - TAKER - fund(c, idx, end), won: raw > 0 ? 1 : 0, entry: idx, exit: end };
}
function clusters(ts) {
  const o = []; let cur = [];
  for (const t of [...ts].sort((a, b) => a.entry - b.entry)) {
    if (cur.length && t.entry <= cur[cur.length - 1].exit) cur.push(t);
    else { if (cur.length) o.push(mean(cur.map((x) => x.net))); cur = [t]; }
  }
  if (cur.length) o.push(mean(cur.map((x) => x.net)));
  return o;
}

async function main() {
  console.log("WICK-BREAK vs CLOSE-BREAK STRUCTURE — a mechanic taken from an external source.");
  console.log("Photon's FRACTAL layer confirms on a WICK break; our calc.js uses body CLOSE only.");
  console.log("Tested where it matters: the regime gate, which #224 showed is the only durable component.");
  console.log("Pivot detection identical in both arms; the break trigger is the sole difference.\n");

  const A = { close: [], wick: [], luxRef: [] };
  const nul = new Array(SEEDS).fill(0).map(() => []);
  let agree = 0, total = 0, wickBullBars = 0, closeBullBars = 0, allBars = 0;

  for (const inst of INSTRUMENTS) {
    let c; try { c = await loadCandles("4h", inst); } catch { continue; }
    if (!c || c.length < 2000) continue;
    const atr = atrSeries(c, ATR_LEN);
    const { orderBlocks, swingBias: lux } = computeSMC(c);
    const bClose = biasSeries(c, "close");
    const bWick = biasSeries(c, "wick");

    for (let i = 0; i < c.length; i++) {
      allBars++;
      if (bClose[i] === bWick[i]) agree++;
      total++;
      if (bWick[i] === BULL) wickBullBars++;
      if (bClose[i] === BULL) closeBullBars++;
    }

    let n = 0;
    for (const ob of orderBlocks) {
      if (ob.side !== "bullish") continue;
      const sig = ob.createdBarIdx, idx = sig + 1;
      if (idx >= c.length) continue;
      const t = trade(c, atr, idx);
      if (!t) continue;
      if (bClose[sig] === BULL) { A.close.push(t); n++; }
      if (bWick[sig] === BULL) A.wick.push(t);
      if (lux[sig] === BULL) A.luxRef.push(t);
    }

    const pool = [];
    for (let i = ATR_LEN + 1; i < c.length - HOLD_BARS - 1; i++) pool.push(i);
    for (let s = 0; s < SEEDS; s++) {
      const rnd = mulberry32(41000 + s * 7919 + inst.length);
      for (let k = 0; k < n; k++) {
        const ix = pool[Math.floor(rnd() * pool.length)];
        const r = trade(c, atr, ix + 1);
        if (r) nul[s].push(r.net);
      }
    }
  }

  const mN = nul.map(mean).filter(Number.isFinite).sort((a, b) => a - b);
  const pct = (v) => (mN.length ? mN.filter((x) => x < v).length / mN.length * 100 : NaN);

  console.log(`Bias agreement between close-break and wick-break: ${((agree / total) * 100).toFixed(1)}% of bars`);
  console.log(`Share of bars flagged BULLISH:  close ${((closeBullBars / allBars) * 100).toFixed(1)}%   wick ${((wickBullBars / allBars) * 100).toFixed(1)}%\n`);
  console.log(`  random-long null ${(mean(mN) * 100).toFixed(4)}%   [95th pct ${(mN[Math.floor(mN.length * 0.95)] * 100).toFixed(4)}%]`);
  console.log("  gate                              n    win%    net%/trade      t   cluster t   vs null");
  for (const [k, g] of [["CLOSE-break bias (ours)", A.close], ["WICK-break bias (Photon)", A.wick], ["LuxAlgo swingBias [ref]", A.luxRef]]) {
    if (g.length < MIN_N) { console.log(`  ${k.padEnd(28)} n=${g.length} -- below n>=${MIN_N}`); continue; }
    const nets = g.map((x) => x.net), cl = clusters(g);
    console.log(`  ${k.padEnd(28)}${String(g.length).padStart(6)}${((g.filter((x) => x.won).length / g.length) * 100).toFixed(1).padStart(8)}%${(mean(nets) * 100).toFixed(4).padStart(13)}%${tOf(nets).toFixed(2).padStart(8)}${tOf(cl).toFixed(2).padStart(11)}${pct(mean(nets)).toFixed(1).padStart(10)}%`);
  }
  console.log("\nThe wick mechanic is worth adopting only if it beats the close-break gate AND its null.");
  console.log("If the two agree on nearly every bar, the distinction is cosmetic at this rung.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });

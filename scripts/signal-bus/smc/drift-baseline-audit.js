#!/usr/bin/env node
// DRIFT BASELINE AUDIT — the control that should have been in every q6 row and was in none of them.
//
// iapaulo, 2026-08-21: "please explain why you sound like q6 (blue line) is predominantly bullish
// when it is defined as bearish... i believe that reason is that price went bullish and the short
// signals turned into countertrend signals."
//
// **HE IS DESCRIBING UNCONDITIONAL DRIFT AND THE OBJECTION IS STRUCTURALLY CORRECT.** Every q6 test
// in this register (#188, #191, #193-#195, #197, #199-#204, #208B) compared a LONG arm to a SHORT
// arm, or a conditioned cell to its complement. **None compared against a RANDOM LONG with identical
// trade mechanics.** Over 2017-2026 these instruments rose by orders of magnitude, so:
//   * any long-vs-short comparison is won by the long side automatically;
//   * "the Downward Boom Line is bullish" (#188) may say nothing about q6 at all;
//   * "+0.6752% conditioned" (#208B PASS) may be the market's drift, not the signal's edge.
//
// THE DECOMPOSITION THAT SETTLES IT — same 2R maker construction, same instruments, same rung:
//   (1) RANDOM long entry, any bar                -> raw drift under this construction
//   (2) RANDOM long entry, bars where swingBias == BULLISH -> drift + the Strong Low regime filter
//   (3) q6 ceiling + Strong Low (the #208B cell)  -> drift + regime + the actual q6 signal
//
// (3) must beat (2) for q6 to carry information, and (2) must beat (1) for Strong Low to. Anything
// that fails to beat its own baseline was never a signal, whatever its t-statistic said.
//
// Random entries are drawn to MATCH THE SIGNAL COUNT per instrument, repeated over many seeds, and
// the observed cell is scored against the resulting null distribution as a percentile — the same
// null-model discipline #143 used and every q6 row omitted.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "./calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const Q6_CEILING = 105, BULL = 1, N_SEEDS = 400;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;
const GROUPS = {
  "ORIGINAL BTC/ETH/SOL/XRP": ["BTC", "ETH", "SOL", "XRP"],
  "FRESH BNB/ADA/LTC/LINK (#208B)": ["BNB", "ADA", "LTC", "LINK"],
};

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}
const fund = (c, i, j) => REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, (c[j].t - c[i].t) / 3600);

function sim(c, atr, idx) {
  if (idx >= c.length) return null;
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0) return null;
  const e = c[idx].o, st = e - ATR_MULT * a, tg = e + R_MULT * ATR_MULT * a;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    if (b.l <= st) return (st - SLIP_STOP_ATR * a - e) / e - MAKER - TAKER - fund(c, idx, j);
    if (b.h >= tg) return (tg - e) / e - 2 * MAKER - fund(c, idx, j);
  }
  if (end < idx + HOLD_BARS) return null;
  return (c[end].c - e) / e - MAKER - TAKER - fund(c, idx, end);
}

async function main() {
  console.log("DRIFT BASELINE AUDIT — the null model every q6 row omitted.");
  console.log("Same 2R maker construction throughout. (1) random long, (2) random long in Strong Low,");
  console.log(`(3) q6 ceiling + Strong Low. ${N_SEEDS} random draws, matched to the signal count per instrument.\n`);

  for (const [label, insts] of Object.entries(GROUPS)) {
    const obs = [];
    const nullAny = new Array(N_SEEDS).fill(0).map(() => []);
    const nullBull = new Array(N_SEEDS).fill(0).map(() => []);
    let totalBars = 0, bullBars = 0, firstPx = 0, lastPx = 0;

    for (const inst of insts) {
      const c = await loadCandles("4h", inst);
      if (c.length < 500) continue;
      const atr = atrSeries(c, ATR_LEN);
      const { swingBias } = computeSMC(c);
      const q6 = computeBoomHunter(c).series.q6;
      totalBars += c.length;
      bullBars += swingBias.filter((b) => b === BULL).length;
      firstPx += 1; lastPx += c[c.length - 1].c / c[Math.max(0, ATR_LEN)].c;

      const sig = [];
      for (let i = 1; i < c.length; i++) {
        if (q6[i] >= Q6_CEILING && q6[i - 1] < Q6_CEILING && swingBias[i] === BULL) sig.push(i);
      }
      for (const i of sig) { const r = sim(c, atr, i + 1); if (r !== null) obs.push(r); }

      // eligible pools for the two null models
      const poolAny = [], poolBull = [];
      for (let i = ATR_LEN + 1; i < c.length - HOLD_BARS - 1; i++) { poolAny.push(i); if (swingBias[i] === BULL) poolBull.push(i); }
      const n = sig.length;
      for (let s = 0; s < N_SEEDS; s++) {
        const rnd = mulberry32(1000 + s * 7919 + inst.length);
        for (let k = 0; k < n; k++) {
          const ia = poolAny[Math.floor(rnd() * poolAny.length)];
          const ra = sim(c, atr, ia + 1); if (ra !== null) nullAny[s].push(ra);
          if (poolBull.length) {
            const ib = poolBull[Math.floor(rnd() * poolBull.length)];
            const rb = sim(c, atr, ib + 1); if (rb !== null) nullBull[s].push(rb);
          }
        }
      }
    }

    const o = mean(obs);
    const mAny = nullAny.map(mean).sort((a, b) => a - b);
    const mBull = nullBull.map(mean).sort((a, b) => a - b);
    const pct = (arr, v) => (arr.filter((x) => x < v).length / arr.length * 100);

    console.log(`===== ${label}   (Strong Low covers ${((bullBars / totalBars) * 100).toFixed(1)}% of bars; buy-and-hold x${(lastPx / insts.length).toFixed(1)} avg)`);
    console.log(`  (1) RANDOM long, any bar          net ${(mean(mAny) * 100).toFixed(4)}%   [5th-95th pct: ${(mAny[Math.floor(N_SEEDS * 0.05)] * 100).toFixed(4)}% .. ${(mAny[Math.floor(N_SEEDS * 0.95)] * 100).toFixed(4)}%]`);
    console.log(`  (2) RANDOM long, in Strong Low    net ${(mean(mBull) * 100).toFixed(4)}%   [5th-95th pct: ${(mBull[Math.floor(N_SEEDS * 0.05)] * 100).toFixed(4)}% .. ${(mBull[Math.floor(N_SEEDS * 0.95)] * 100).toFixed(4)}%]`);
    console.log(`  (3) q6 ceiling + Strong Low       net ${(o * 100).toFixed(4)}%   n=${obs.length}`);
    console.log(`      -> percentile of (3) against null (1): ${pct(mAny, o).toFixed(1)}%   against null (2): ${pct(mBull, o).toFixed(1)}%`);
    const verdict2 = pct(mBull, o) >= 95 ? "q6 ADDS information beyond the regime" : pct(mBull, o) >= 50 ? "q6 is INDISTINGUISHABLE from a random long inside the same regime" : "q6 is WORSE than a random long inside the same regime";
    console.log(`      -> ${verdict2}`);
    console.log(`      -> Strong Low regime vs any bar: ${(mean(mBull) * 100).toFixed(4)}% vs ${(mean(mAny) * 100).toFixed(4)}%  (${mean(mBull) > mean(mAny) ? "regime helps" : "regime does not help"})\n`);
  }
  console.log("A cell that cannot beat a random long drawn from the same regime was never a signal,");
  console.log("whatever its t-statistic said. This control was absent from every prior q6 row.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });

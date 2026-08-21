#!/usr/bin/env node
// GRID-PHASE AUDIT — iapaulo's objection, made testable.
//
// His objection, 2026-08-21: "its rediculous that you thing you can find dynamic signals as we are
// which manifest in accordance with an ever moving price, by looking at it once per hour or whatever
// static timeframe you are looking at."
//
// **THE OBJECTION IS STRUCTURALLY CORRECT AND THIS QUANTIFIES ITS COST.** Every result in this
// register is computed on a 4h grid whose boundaries are an arbitrary human convention (00:00, 04:00,
// 08:00 UTC...). A condition that becomes true at 13:47 is not observable until the 16:00 close and
// is filled at the 20:00 open. The market does not respect that grid.
//
// THE TEST: rebuild the SAME 4h series from 1h data at FOUR PHASE OFFSETS (0, 1, 2, 3 hours) and run
// the identical construction on each. The signal, the structure, the regime, the trades -- everything
// recomputed per phase, nothing read from a DB built on the standard grid.
//
//   * If the construction is a real property of price, it should appear on ALL FOUR phases with
//     similar magnitude. The grid is then a sampling detail, not the source of the result.
//   * If it appears on one phase and not others, IT IS AN ARTIFACT OF WHERE WE CUT THE BARS, and
//     every register row built on the standard grid inherits that artifact.
//
// Construction under test: #211's `bullish OB created inside Strong Low, 4h, 2R maker` -- currently
// the best candidate in the project (97.3rd / 99.7th percentile vs matched null). Each phase gets
// its own random-entry null drawn from that phase's own Strong Low population, per #210's rule.
//
// Uses ONLY existing 1h data. No fetching (iapaulo, 2026-08-21).

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "./calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const BULL = 1, SEEDS = 200;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;
const GROUPS = {
  "ORIGINAL BTC/ETH/SOL/XRP": ["BTC", "ETH", "SOL", "XRP"],
  "FRESH BNB/ADA/LTC/LINK": ["BNB", "ADA", "LTC", "LINK"],
};

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build 4h candles from 1h with a phase offset in hours. Phase 0 reproduces the standard grid.
//
// BUCKETED BY TIMESTAMP ARITHMETIC, not by sequential slicing. The first version of this function
// walked the array in steps of 4 and resynced by +1 on any gap -- so a single missing hour shifted
// the phase permanently, all four "phases" drifted into the same grid, and the audit reported
// identical n and identical net for every phase. That output was discarded, not published.
function aggregate4h(h1, phaseHours) {
  const buckets = new Map();
  for (const b of h1) {
    const k = Math.floor((b.t - phaseHours * 3600) / 14400);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(b);
  }
  const out = [];
  for (const [k, g] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (g.length < 3) continue;                       // too incomplete to be a bar
    g.sort((a, b) => a.t - b.t);
    out.push({
      t: k * 14400 + phaseHours * 3600, o: g[0].o,
      h: Math.max(...g.map((x) => x.h)),
      l: Math.min(...g.map((x) => x.l)),
      c: g[g.length - 1].c,
      v: g.reduce((s, x) => s + (x.v || 0), 0),
    });
  }
  return out;
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
  console.log("GRID-PHASE AUDIT — is the 4h result a property of price, or of where we cut the bars?");
  console.log("#211's construction (bullish OB inside Strong Low, 4h, 2R maker) recomputed from 1h at");
  console.log("four phase offsets. Phase 0 = the standard grid every register row uses.\n");

  for (const [label, insts] of Object.entries(GROUPS)) {
    console.log(`===== ${label}`);
    console.log("  phase   signals    net%/trade   null net%   percentile   signal times");
    const netsByPhase = [];
    for (const phase of [0, 1, 2, 3]) {
      const obs = [];
      const nul = new Array(SEEDS).fill(0).map(() => []);
      let hours = new Set();
      for (const inst of insts) {
        const h1 = await loadCandles("1h", inst);
        if (h1.length < 2000) continue;
        const c = aggregate4h(h1, phase);
        if (c.length < 500) continue;
        const atr = atrSeries(c, ATR_LEN);
        const { orderBlocks, swingBias } = computeSMC(c);
        let n = 0;
        for (const ob of orderBlocks) {
          if (ob.side !== "bullish") continue;
          const i = ob.createdBarIdx;
          if (swingBias[i] !== BULL) continue;
          const r = sim(c, atr, i + 1);
          if (r === null) continue;
          obs.push(r); n++;
          hours.add(new Date(c[i].t * 1000).getUTCHours());
        }
        const pool = [];
        for (let i = ATR_LEN + 1; i < c.length - HOLD_BARS - 1; i++) if (swingBias[i] === BULL) pool.push(i);
        for (let s = 0; s < SEEDS; s++) {
          const rnd = mulberry32(5000 + s * 7919 + phase * 31 + inst.length);
          for (let k = 0; k < n; k++) {
            const ix = pool[Math.floor(rnd() * pool.length)];
            const r = sim(c, atr, ix + 1);
            if (r !== null) nul[s].push(r);
          }
        }
      }
      const o = mean(obs);
      const mN = nul.map(mean).sort((a, b) => a - b);
      const pct = mN.filter((x) => x < o).length / mN.length * 100;
      netsByPhase.push(o);
      console.log(`  +${phase}h  ${String(obs.length).padStart(7)}  ${(o * 100).toFixed(4).padStart(12)}%  ${(mean(mN) * 100).toFixed(4).padStart(10)}%  ${pct.toFixed(1).padStart(10)}%   UTC hours {${[...hours].sort((a, b) => a - b).join(",")}}`);
    }
    const m = mean(netsByPhase), disp = sd(netsByPhase);
    console.log(`  across phases: mean ${(m * 100).toFixed(4)}%  sd ${(disp * 100).toFixed(4)}pp  min ${(Math.min(...netsByPhase) * 100).toFixed(4)}%  max ${(Math.max(...netsByPhase) * 100).toFixed(4)}%`);
    console.log(`  -> ${netsByPhase.every((x) => x > 0) ? "SURVIVES ALL FOUR PHASES" : "PHASE-DEPENDENT -- fails on at least one grid alignment"}\n`);
  }
  console.log("A construction that only works on one phase alignment is an artifact of the grid, not");
  console.log("a property of price. This is the first time any row in this register has been checked for it.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });

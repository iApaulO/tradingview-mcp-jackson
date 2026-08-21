#!/usr/bin/env node
// PLAIN PIVOTS AS A TRADE CONSTRUCTION — the direct consequence of #223.
//
// NOTE ON SCOPE, because my own phrasing last turn was muddled: the OB-in-Strong-Low construction
// (#211/#212, now pre-registered forward) uses ORDER BLOCKS and never used pivot clusters, so
// "running it off plain pivots" was not a coherent substitution. **What #223 actually licenses is
// this:** it showed 80% of the level-reaction effect comes from being a confirmed pivot at all and
// only 20% from k>=3 clustering. The testable consequence is whether PLAIN PIVOT LEVELS -- a
// population 2.4x larger than the clustered subset -- are tradeable, and whether clustering earns
// its restriction once a stop is applied.
//
// #192 is the standing warning and it applies with full force: liquidity pools cleared their null
// at z=3.27 and were untradeable; breakers cleared theirs at z=7-10 and were untradeable (#218).
// Two independent objects, same outcome. **The prior here is failure.**
//
// CONSTRUCTION -- fade the level, which is what a support/resistance claim asserts:
//   pivot LOW  approached from above -> support    -> LONG,  resting buy limit at the pivot price
//   pivot HIGH approached from below -> resistance -> SHORT, resting sell limit at the pivot price
//   Maker entry (a limit cannot fill worse). Stop 2.0x ATR(14) with taker + 0.15 ATR slippage.
//   Target 2R (maker). 200-bar timeout. Funding throughout.
//
// ARMS: ISOLATED pivots vs CLUSTERED (k>=3) vs -- for the long side -- each gated on Strong Low,
// since #199/#210 established that regime state is interactional rather than a main effect.
//
// CONTROLS: same-side random-entry null matched by count (#210); per-rung, never pooled (#204);
// cluster t alongside naive t (#204). 4h, nine instruments.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "../smc/calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, PIVOT_LEFT = 5, PIVOT_RIGHT = 5, MARGIN_DIV = 2.5;
const ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const MAX_WAIT = 400, MIN_N = 60, SEEDS = 300, BULL = 1;
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

function pivots(c) {
  const out = [];
  for (let p = PIVOT_LEFT; p < c.length - PIVOT_RIGHT; p++) {
    let isH = true, isL = true;
    for (let k = p - PIVOT_LEFT; k <= p + PIVOT_RIGHT; k++) {
      if (k === p) continue;
      if (c[k].h >= c[p].h) isH = false;
      if (c[k].l <= c[p].l) isL = false;
    }
    if (isH) out.push({ confirm: p + PIVOT_RIGHT, price: c[p].h, side: 1 });
    if (isL) out.push({ confirm: p + PIVOT_RIGHT, price: c[p].l, side: -1 });
  }
  return out;
}

function trade(c, atr, i, entry, dir) {
  const a = atr[i];
  if (!Number.isFinite(a) || a <= 0) return null;
  const risk = ATR_MULT * a;
  const st = dir === "long" ? entry - risk : entry + risk;
  const tg = dir === "long" ? entry + R_MULT * risk : entry - R_MULT * risk;
  const end = Math.min(c.length - 1, i + HOLD_BARS);
  for (let j = i; j <= end; j++) {
    const b = c[j];
    const hs = dir === "long" ? b.l <= st : b.h >= st;
    const ht = dir === "long" ? b.h >= tg : b.l <= tg;
    if (hs) { const f = dir === "long" ? st - SLIP_STOP_ATR * a : st + SLIP_STOP_ATR * a;
      const raw = dir === "long" ? (f - entry) / entry : (entry - f) / entry;
      return { net: raw - MAKER - TAKER - fund(c, i, j), won: 0, entry: i, exit: j }; }
    if (ht) { const raw = dir === "long" ? (tg - entry) / entry : (entry - tg) / entry;
      return { net: raw - 2 * MAKER - fund(c, i, j), won: 1, entry: i, exit: j }; }
  }
  if (end < i + HOLD_BARS) return null;
  const raw = dir === "long" ? (c[end].c - entry) / entry : (entry - c[end].c) / entry;
  return { net: raw - MAKER - TAKER - fund(c, i, end), won: raw > 0 ? 1 : 0, entry: i, exit: end };
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
  console.log("PLAIN PIVOTS AS A TRADE CONSTRUCTION — the consequence of #223 (80% of the level effect");
  console.log("comes from being a pivot at all, only 20% from k>=3 clustering).");
  console.log("Fade the level: LONG at a pivot low from above, SHORT at a pivot high from below.");
  console.log("Maker limit entry, 2.0x ATR stop, 2R target. Prior is FAILURE -- #192 and #218 both");
  console.log("cleared strong nulls and were untradeable.\n");

  const A = {};
  const add = (k, t) => { (A[k] ??= []).push(t); };
  const nul = { long: new Array(SEEDS).fill(0).map(() => []), short: new Array(SEEDS).fill(0).map(() => []) };

  for (const inst of INSTRUMENTS) {
    let c; try { c = await loadCandles("4h", inst); } catch { continue; }
    if (!c || c.length < 2000) continue;
    const atr = atrSeries(c, ATR_LEN);
    const { swingBias } = computeSMC(c);
    const pv = pivots(c);
    let nL = 0, nS = 0;

    for (let n = 0; n < pv.length; n++) {
      const p = pv[n];
      const a0 = atr[p.confirm];
      if (!Number.isFinite(a0) || a0 <= 0) continue;
      const band = a0 / MARGIN_DIV;
      let others = 0;
      for (let m = 0; m < n; m++) {
        const q = pv[m];
        if (q.side !== p.side || q.confirm > p.confirm) continue;
        if (Math.abs(q.price - p.price) <= band) others++;
      }
      const clustered = others >= 2;
      const dir = p.side === -1 ? "long" : "short";
      const fromBelow = p.side === 1;

      let t = -1;
      const end = Math.min(c.length - 1, p.confirm + 1 + MAX_WAIT);
      for (let j = p.confirm + 1; j <= end; j++) {
        if (fromBelow ? c[j].h >= p.price : c[j].l <= p.price) { t = j; break; }
      }
      if (t < 0) continue;
      const tr = trade(c, atr, t, p.price, dir);
      if (!tr) continue;
      if (dir === "long") nL++; else nS++;

      add(`${dir} :: ${clustered ? "CLUSTERED" : "ISOLATED"}`, tr);
      add(`${dir} :: ALL pivots`, tr);
      if (dir === "long" && swingBias[t] === BULL) add("long :: ALL + Strong Low", tr);
    }

    const pool = [];
    for (let i = ATR_LEN + 1; i < c.length - HOLD_BARS - 1; i++) pool.push(i);
    for (const [dir, n] of [["long", nL], ["short", nS]]) {
      for (let s = 0; s < SEEDS; s++) {
        const rnd = mulberry32(31000 + s * 7919 + inst.length + dir.length);
        for (let k = 0; k < n; k++) {
          const ix = pool[Math.floor(rnd() * pool.length)];
          const e = c[ix + 1]?.o;
          if (!Number.isFinite(e)) continue;
          const r = trade(c, atr, ix + 1, e, dir);
          if (r) nul[dir][s].push(r.net);
        }
      }
    }
  }

  for (const dir of ["long", "short"]) {
    const mN = nul[dir].map(mean).filter(Number.isFinite).sort((a, b) => a - b);
    const pct = (v) => (mN.length ? mN.filter((x) => x < v).length / mN.length * 100 : NaN);
    console.log(`===== ${dir.toUpperCase()}   random-${dir} null ${(mean(mN) * 100).toFixed(4)}%   [95th pct ${(mN[Math.floor(mN.length * 0.95)] * 100).toFixed(4)}%]`);
    const keys = Object.keys(A).filter((k) => k.startsWith(dir)).sort();
    for (const k of keys) {
      const g = A[k];
      if (g.length < MIN_N) { console.log(`  ${k.padEnd(30)} n=${g.length} -- below n>=${MIN_N}`); continue; }
      const nets = g.map((x) => x.net), cl = clusters(g);
      console.log(`  ${k.padEnd(30)} n=${String(g.length).padStart(6)}  win ${((g.filter((x) => x.won).length / g.length) * 100).toFixed(1).padStart(5)}%  net ${(mean(nets) * 100).toFixed(4).padStart(10)}%  t ${tOf(nets).toFixed(2).padStart(6)}  cluster t ${tOf(cl).toFixed(2).padStart(6)}  vs null ${pct(mean(nets)).toFixed(1)}%`);
    }
    console.log("");
  }
  console.log("Plain pivots are usable only if an ISOLATED or ALL arm is positive AND beats its same-side null.");
  console.log("If clustered ~= isolated ~= negative, #223's 2pp increment does not survive a stop either.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });

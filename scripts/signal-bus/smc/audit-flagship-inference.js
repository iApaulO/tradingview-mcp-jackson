#!/usr/bin/env node
// AUDIT OF THE FLAGSHIP CELL -- `q6 ceiling + Strong Low, LONG, maker` (+0.4955%, t=3.82, n=2,128 in #200).
//
// Three suspected inference errors, each of which would weaken that number WITHOUT any new data:
//
//   (1) OVERLAPPING TRADES. Every t-stat this session treats trades as independent. With
//       HOLD_BARS=200 and q6 excursions arriving roughly every ~100 bars on 1h, consecutive trades'
//       holding windows overlap -- they ride the same price path and their PnLs are correlated.
//       Fix here: chain trades whose windows overlap into CLUSTERS, take cluster means, and compute
//       t across clusters. Conservative (clusters are fewer than trades) but honest.
//
//   (2) CROSS-RUNG DOUBLE-COUNTING. #199/#200 pooled 1h AND 4h for the same instrument. A 4h q6
//       excursion and a 1h q6 excursion at the same time are the SAME market episode. Measured here:
//       how many 4h events have a 1h event within +/-4h. Also: per-rung results reported separately,
//       which is the presentation that cannot double-count.
//
//   (3) MULTIPLICITY. Not fixable by computation after the fact -- the cell was selected across many
//       session looks -- but the audit states the discount explicitly rather than ignoring it.
//
// Same trade mechanics as #200's maker path (entry next bar open, no entry slip, maker entry+target,
// taker+slip stop). Only the INFERENCE changes.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "./calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;
const BULL = 1;
const INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const tOf = (xs) => { if (xs.length < 2) return NaN; const s = sd(xs) * Math.sqrt(xs.length / (xs.length - 1)); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN; };

function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}

// maker-path long, returns exit bar for overlap chaining
function sim(c, atr, idx) {
  if (idx >= c.length) return null;
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0) return null;
  const risk = ATR_MULT * a, e = c[idx].o, st = e - risk, tg = e + R_MULT * risk;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    if (b.l <= st) {
      const raw = (st - SLIP_STOP_ATR * a - e) / e;
      return { net: raw - MAKER - TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * ((b.t - c[idx].t) / 3600), entry: idx, exit: j };
    }
    if (b.h >= tg) {
      const raw = (tg - e) / e;
      return { net: raw - 2 * MAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * ((b.t - c[idx].t) / 3600), entry: idx, exit: j };
    }
  }
  if (end <= idx) return null;
  const raw = (c[end].c - e) / e;
  return { net: raw - MAKER - TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * ((c[end].t - c[idx].t) / 3600), entry: idx, exit: end };
}

// chain overlapping trades into clusters, return cluster mean nets
function clusters(trades) {
  const out = [];
  let cur = [];
  for (const t of trades.sort((a, b) => a.entry - b.entry)) {
    if (cur.length && t.entry <= cur[cur.length - 1].exit) cur.push(t);
    else { if (cur.length) out.push(mean(cur.map((x) => x.net))); cur = [t]; }
  }
  if (cur.length) out.push(mean(cur.map((x) => x.net)));
  return out;
}

function report(label, trades) {
  if (!trades.length) return console.log(`  ${label.padEnd(26)} n=0`);
  const cl = clusters(trades);
  const nets = trades.map((x) => x.net);
  console.log(
    `  ${label.padEnd(26)} trades ${String(trades.length).padStart(5)}  naive t ${tOf(nets).toFixed(2).padStart(6)}` +
    `   clusters ${String(cl.length).padStart(4)}  net ${(mean(nets) * 100).toFixed(4)}%  cluster-mean net ${(mean(cl) * 100).toFixed(4)}%  CLUSTER t ${tOf(cl).toFixed(2).padStart(6)}`);
}

async function main() {
  console.log("AUDIT: q6 ceiling + Strong Low, LONG, maker path -- overlap-robust inference + per-rung split.\n");

  const byRung = { "1h": [], "4h": [] };
  const eventTimes = { "1h": {}, "4h": {} };

  for (const inst of INSTRUMENTS) {
    for (const tf of ["1h", "4h"]) {
      const c = await loadCandles(tf, inst);
      if (c.length < 1000) continue;
      const atr = atrSeries(c, ATR_LEN);
      const { swingBias } = computeSMC(c);
      const { series } = computeBoomHunter(c);
      const q6 = series.q6;
      const trades = [];
      const times = [];
      for (let i = 1; i < c.length; i++) {
        if (!(q6[i] >= 105 && q6[i - 1] < 105)) continue;
        times.push(c[i].t);
        if (swingBias[i] !== BULL) continue;
        const t = sim(c, atr, i + 1);
        if (t) trades.push(t);
      }
      eventTimes[tf][inst] = times;
      byRung[tf].push({ inst, trades });
    }
  }

  // (2) cross-rung double-counting
  let dup = 0, tot4 = 0;
  for (const inst of INSTRUMENTS) {
    const h1 = eventTimes["1h"][inst] || [], h4 = eventTimes["4h"][inst] || [];
    const set1 = h1;
    for (const t4 of h4) {
      tot4++;
      if (set1.some((t1) => Math.abs(t1 - t4) <= 4 * 3600)) dup++;
    }
  }
  console.log(`(2) CROSS-RUNG DOUBLE-COUNT: ${dup} of ${tot4} 4h q6 events (${((dup / tot4) * 100).toFixed(1)}%) have a 1h event within +/-4h.`);
  console.log("    Pooling 1h+4h therefore counts those episodes twice. Per-rung is the honest presentation:\n");

  for (const tf of ["1h", "4h"]) {
    console.log(`  --- ${tf}`);
    const all = [];
    for (const { inst, trades } of byRung[tf]) { report(`${inst}`, trades); all.push(...trades.map((t, k) => ({ ...t, entry: t.entry + k * 0 }))); }
    // pooled within rung: cluster per-instrument then combine cluster means (instruments are separate series)
    const clAll = byRung[tf].flatMap(({ trades }) => clusters(trades));
    const netsAll = byRung[tf].flatMap(({ trades }) => trades.map((x) => x.net));
    console.log(`  ${("POOLED " + tf).padEnd(26)} trades ${String(netsAll.length).padStart(5)}  naive t ${tOf(netsAll).toFixed(2).padStart(6)}   clusters ${String(clAll.length).padStart(4)}  net ${(mean(netsAll) * 100).toFixed(4)}%  cluster-mean net ${(mean(clAll) * 100).toFixed(4)}%  CLUSTER t ${tOf(clAll).toFixed(2).padStart(6)}\n`);
  }

  console.log("(3) MULTIPLICITY: this cell was selected across dozens of arms this session. Whatever survives");
  console.log("    above should be read against that -- a nominal p from the cluster t is still optimistic.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });

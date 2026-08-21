#!/usr/bin/env node
// PRE-REGISTERED SINGLE RUN — MSS R4 and flagship q6+StrongLow on BNB/ADA/LTC/LINK.
// Spec: skills/ict-smc-trader/PREREGISTRATION-fresh-instruments.md, committed before any data for
// these instruments existed on disk. THIS RUNS ONCE. Every constant is hard-coded.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { buildMssR4 } from "./mss-r4-builder.js";
import { computeSMC } from "./calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

// ---- FROZEN. Do not parameterise. ----
const INSTRUMENTS = ["BNB", "ADA", "LTC", "LINK"];
const ATR_LEN = 14, ATR_MULT = 2.0, R2 = 2, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const Q6_CEILING = 105;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;
const MIN_N_A = 40, MIN_N_B = 60;
const BULL = 1;

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

// flagship 2R maker-path long (#200), returns entry/exit for clustering
function simR2(c, atr, idx) {
  if (idx >= c.length) return null;
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0) return null;
  const e = c[idx].o, st = e - ATR_MULT * a, tg = e + R2 * ATR_MULT * a;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    if (b.l <= st) return { net: (st - SLIP_STOP_ATR * a - e) / e - MAKER - TAKER - fund(c, idx, j), entry: idx, exit: j, won: 0 };
    if (b.h >= tg) return { net: (tg - e) / e - 2 * MAKER - fund(c, idx, j), entry: idx, exit: j, won: 1 };
  }
  if (end <= idx || end < idx + HOLD_BARS) return null;   // window off the data edge -> excluded, not mtm'd
  const raw = (c[end].c - e) / e;
  return { net: raw - MAKER - TAKER - fund(c, idx, end), entry: idx, exit: end, won: raw > 0 ? 1 : 0 };
}
const fund = (c, i, j) => REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, (c[j].t - c[i].t) / 3600);

function clusters(trades) {
  const out = []; let cur = [];
  for (const t of [...trades].sort((a, b) => a.entry - b.entry)) {
    if (cur.length && t.entry <= cur[cur.length - 1].exit) cur.push(t);
    else { if (cur.length) out.push(mean(cur.map((x) => x.net))); cur = [t]; }
  }
  if (cur.length) out.push(mean(cur.map((x) => x.net)));
  return out;
}

async function main() {
  console.log("PRE-REGISTERED RUN — fresh instruments BNB/ADA/LTC/LINK, executed once.");
  console.log("Spec: skills/ict-smc-trader/PREREGISTRATION-fresh-instruments.md\n");

  // ---------------- Test A: MSS R4 ----------------
  const aAll = [], aPer = {};
  for (const inst of INSTRUMENTS) {
    const c = await loadCandles("4h", inst);
    const { trades } = buildMssR4(inst, c);
    const done = trades.filter((t) => t.status === "resolved");
    aPer[inst] = done;
    aAll.push(...done.map((t) => ({ net: t.netPct, won: t.netPct > 0 ? 1 : 0 })));
  }
  console.log("TEST A — MSS R4 (bullish 4h swing CHoCH, 2.0x ATR stop, 4R target, maker)");
  for (const inst of INSTRUMENTS) {
    const g = aPer[inst];
    console.log(`  ${inst.padEnd(5)} n=${String(g.length).padStart(4)}  net ${g.length ? (mean(g.map((t) => t.netPct)) * 100).toFixed(4) : "--"}%`);
  }
  const aNet = mean(aAll.map((t) => t.net));
  console.log(`  POOLED n=${aAll.length}  win ${((aAll.filter((t) => t.won).length / Math.max(1, aAll.length)) * 100).toFixed(1)}%  net ${(aNet * 100).toFixed(4)}%  t ${tOf(aAll.map((t) => t.net)).toFixed(2)}`);
  const a2ok = aAll.length >= MIN_N_A;
  const a1ok = a2ok && aNet > 0;
  console.log(`  A-2 n >= ${MIN_N_A} .......... ${a2ok ? "MET" : "NOT MET"} (n=${aAll.length})`);
  console.log(`  A-1 pooled net > 0 ... ${a1ok ? "MET" : "NOT MET"} (${(aNet * 100).toFixed(4)}%)`);
  const verdictA = !a2ok ? "INCONCLUSIVE" : a1ok ? "PASS" : "FAIL";
  console.log(`  VERDICT A: ${verdictA}\n`);

  // ---------------- Test B: flagship q6 + Strong Low ----------------
  const bCond = [], bComp = [];
  const bPer = {};
  for (const inst of INSTRUMENTS) {
    const c = await loadCandles("4h", inst);
    const atr = atrSeries(c, ATR_LEN);
    const { swingBias } = computeSMC(c);
    const q6 = computeBoomHunter(c).series.q6;
    const per = { cond: [], comp: [] };
    for (let i = 1; i < c.length; i++) {
      if (!(q6[i] >= Q6_CEILING && q6[i - 1] < Q6_CEILING)) continue;
      const t = simR2(c, atr, i + 1);
      if (!t) continue;
      if (swingBias[i] === BULL) { bCond.push(t); per.cond.push(t); }
      else { bComp.push(t); per.comp.push(t); }
    }
    bPer[inst] = per;
  }
  console.log("TEST B — flagship: q6 ceiling (>=105) + Strong Low, 4h, LONG, 2R, maker");
  for (const inst of INSTRUMENTS) {
    const p = bPer[inst];
    console.log(`  ${inst.padEnd(5)} cond n=${String(p.cond.length).padStart(4)} net ${p.cond.length ? (mean(p.cond.map((t) => t.net)) * 100).toFixed(4) : "--"}%   comp n=${String(p.comp.length).padStart(4)} net ${p.comp.length ? (mean(p.comp.map((t) => t.net)) * 100).toFixed(4) : "--"}%`);
  }
  const bNet = mean(bCond.map((t) => t.net));
  const bCompNet = mean(bComp.map((t) => t.net));
  const clCond = INSTRUMENTS.flatMap((inst) => clusters(bPer[inst].cond));
  console.log(`  POOLED cond n=${bCond.length}  win ${((bCond.filter((t) => t.won).length / Math.max(1, bCond.length)) * 100).toFixed(1)}%  net ${(bNet * 100).toFixed(4)}%  cluster t ${tOf(clCond).toFixed(2)} (${clCond.length} clusters)`);
  console.log(`  POOLED comp n=${bComp.length}  net ${(bCompNet * 100).toFixed(4)}%`);
  const b3ok = bCond.length >= MIN_N_B;
  const b1ok = b3ok && bNet > 0;
  const b2ok = b3ok && bNet > bCompNet;
  console.log(`  B-3 n >= ${MIN_N_B} ................. ${b3ok ? "MET" : "NOT MET"} (n=${bCond.length})`);
  console.log(`  B-1 conditioned net > 0 ...... ${b1ok ? "MET" : "NOT MET"} (${(bNet * 100).toFixed(4)}%)`);
  console.log(`  B-2 conditioned beats comp ... ${b2ok ? "MET" : "NOT MET"} (${(bNet * 100).toFixed(4)}% vs ${(bCompNet * 100).toFixed(4)}%)`);
  const verdictB = !b3ok ? "INCONCLUSIVE" : b1ok && b2ok ? "PASS" : "FAIL";
  console.log(`  VERDICT B: ${verdictB}`);
  console.log("\nRecorded as-is. No partial credit, no amendment, no re-run.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });

#!/usr/bin/env node
// PRE-REGISTERED SINGLE RUN — regime depth on XLM/TRX/ETC/DOGE.
// Spec: skills/ict-smc-trader/PREREGISTRATION-regime-depth.md, committed before these instruments
// were fetched. THIS RUNS ONCE. Every constant is hard-coded, including DEPTH_SPLIT.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "./calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { dbSuffix } from "../lib/instrument.js";

// ---- FROZEN ----
const INSTRUMENTS = ["XLM", "TRX", "ETC", "DOGE"];
const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const Q6_CEILING = 105;
const DEPTH_SPLIT = 12;          // bars on 4h = two calendar days, fixed a priori
const MIN_N = 60;
const BULL = 1;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const tOf = (xs) => { if (xs.length < 2) return NaN; const s = sd(xs) * Math.sqrt(xs.length / (xs.length - 1)); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN; };

function rank(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function spearman(a, b) {
  if (a.length < 3) return NaN;
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < n; i++) { const x = ra[i] - ma, y = rb[i] - mb; num += x * y; da += x * x; dbb += y * y; }
  return da > 0 && dbb > 0 ? num / Math.sqrt(da * dbb) : NaN;
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
    if (b.l <= st) return { net: (st - SLIP_STOP_ATR * a - e) / e - MAKER - TAKER - fund(c, idx, j), entry: idx, exit: j, won: 0 };
    if (b.h >= tg) return { net: (tg - e) / e - 2 * MAKER - fund(c, idx, j), entry: idx, exit: j, won: 1 };
  }
  if (end < idx + HOLD_BARS) return null;      // window off the data edge -> excluded
  const raw = (c[end].c - e) / e;
  return { net: raw - MAKER - TAKER - fund(c, idx, end), entry: idx, exit: end, won: raw > 0 ? 1 : 0 };
}

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
  console.log("PRE-REGISTERED RUN — regime depth, XLM/TRX/ETC/DOGE, executed once.");
  console.log("Spec: skills/ict-smc-trader/PREREGISTRATION-regime-depth.md");
  console.log(`Construction inherited from #208B unchanged. SHALLOW = depth <= ${DEPTH_SPLIT} bars, DEEP = depth > ${DEPTH_SPLIT}.\n`);

  const shallow = [], deep = [], perInst = {};
  const depths = [], nets = [];

  for (const inst of INSTRUMENTS) {
    const c = await loadCandles("4h", inst);
    if (c.length < 500) { console.log(`  ${inst}: insufficient candles, skipped`); continue; }
    const atr = atrSeries(c, ATR_LEN);
    const idxOf = new Map(c.map((x, i) => [x.t, i]));
    const { swingBias } = computeSMC(c);
    const q6 = computeBoomHunter(c).series.q6;

    const db = new DatabaseSync(new URL(`../../../data/signal-bus/smc${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
    const mssBars = db.prepare("SELECT time FROM structure_events WHERE timeframe='4h' AND instrument=? AND type='CHOCH' AND side='bullish' AND scope='swing' ORDER BY time")
      .all(inst).map((r) => idxOf.get(r.time)).filter((v) => v !== undefined).sort((a, b) => a - b);
    db.close();

    const per = { shallow: [], deep: [] };
    let ptr = 0, lastMss = null;
    for (let i = 1; i < c.length; i++) {
      while (ptr < mssBars.length && mssBars[ptr] <= i) { lastMss = mssBars[ptr]; ptr++; }
      if (!(q6[i] >= Q6_CEILING && q6[i - 1] < Q6_CEILING)) continue;
      if (swingBias[i] !== BULL) continue;
      if (lastMss === null) continue;
      const depth = i - lastMss;
      const t = sim(c, atr, i + 1);
      if (!t) continue;
      depths.push(depth); nets.push(t.net);
      if (depth <= DEPTH_SPLIT) { shallow.push(t); per.shallow.push(t); }
      else { deep.push(t); per.deep.push(t); }
    }
    perInst[inst] = per;
  }

  console.log("per instrument (net%/trade):");
  for (const inst of INSTRUMENTS) {
    const p = perInst[inst]; if (!p) continue;
    console.log(`  ${inst.padEnd(5)} SHALLOW n=${String(p.shallow.length).padStart(4)} ${p.shallow.length ? (mean(p.shallow.map((t) => t.net)) * 100).toFixed(4) : "  --"}%    DEEP n=${String(p.deep.length).padStart(4)} ${p.deep.length ? (mean(p.deep.map((t) => t.net)) * 100).toFixed(4) : "  --"}%`);
  }

  const sNet = mean(shallow.map((t) => t.net)), dNet = mean(deep.map((t) => t.net));
  const clS = INSTRUMENTS.flatMap((i) => clusters(perInst[i]?.shallow || []));
  const clD = INSTRUMENTS.flatMap((i) => clusters(perInst[i]?.deep || []));
  console.log("");
  console.log(`  POOLED SHALLOW n=${shallow.length}  win ${((shallow.filter((t) => t.won).length / Math.max(1, shallow.length)) * 100).toFixed(1)}%  net ${(sNet * 100).toFixed(4)}%  cluster t ${tOf(clS).toFixed(2)}`);
  console.log(`  POOLED DEEP    n=${deep.length}  win ${((deep.filter((t) => t.won).length / Math.max(1, deep.length)) * 100).toFixed(1)}%  net ${(dNet * 100).toFixed(4)}%  cluster t ${tOf(clD).toFixed(2)}`);
  console.log(`  Spearman rho(depth, net) = ${spearman(depths, nets).toFixed(4)}  (n=${depths.length})`);

  const d3 = shallow.length >= MIN_N && deep.length >= MIN_N;
  const d1 = d3 && dNet > sNet;
  const d2 = d3 && dNet > 0;
  console.log("\n---- CRITERIA (spec section 5) ----");
  console.log(`  D-3 n >= ${MIN_N} in BOTH buckets ... ${d3 ? "MET" : "NOT MET"} (shallow ${shallow.length}, deep ${deep.length})`);
  console.log(`  D-1 DEEP > SHALLOW ............ ${d1 ? "MET" : "NOT MET"} (${(dNet * 100).toFixed(4)}% vs ${(sNet * 100).toFixed(4)}%)`);
  console.log(`  D-2 DEEP > 0 .................. ${d2 ? "MET" : "NOT MET"} (${(dNet * 100).toFixed(4)}%)`);
  const verdict = !d3 ? "INCONCLUSIVE (population floor)" : d1 && d2 ? "PASS" : "FAIL";
  console.log(`\n  VERDICT: ${verdict}`);
  console.log(`  D-4 reported: SHALLOW is ${sNet < 0 ? "ACTIVELY NEGATIVE (corroborates #208A)" : "positive but weaker"}.`);
  console.log("\nRecorded as-is. No partial credit, no amendment, no re-run at a different depth threshold.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });

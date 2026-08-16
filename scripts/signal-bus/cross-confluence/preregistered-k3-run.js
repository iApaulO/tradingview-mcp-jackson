#!/usr/bin/env node
// PRE-REGISTERED RUN of the K>=3 co-occurrence construction.
//
// The configuration and the pass/fail criteria are frozen in
// skills/ict-smc-trader/PREREGISTRATION-cooccurrence-k3.md, committed BEFORE the test instrument's
// data existed in this repository (`ls data/historical/ | grep -i sol` returned nothing at that
// commit). Nothing below may be tuned. Every constant is hard-coded rather than exposed as a CLI
// flag, deliberately: a sweepable parameter is a parameter that will get swept.
//
// This exists because #142 left exactly one objection standing -- roughly 25+ configurations were
// swept across #138/#140/#141/#142 with no multiple-testing correction. Monotonicity and
// cross-instrument replication are a real defence but they are an argument, not a correction. The
// only honest answer is a configuration fixed before its result is seen, run once, on data that
// never informed the hypothesis.
//
// Usage: node scripts/signal-bus/cross-confluence/preregistered-k3-run.js [--instrument=SOL]

import { writeFileSync, mkdirSync } from "fs";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { loadStructureEvents, buildCooccurrenceClusters } from "./lib/cooccurrence.js";

// ── FROZEN CONFIGURATION — DO NOT EDIT ──────────────────────────────────────────────────────
const CLUSTER_MULT = 1;        // window multiplier, symmetric coarser-rung rule (#135)
const ATR_LEN = 14;
const ATR_MULT = 2.0;          // mid-range of the clearing region, NOT the best cell (3.0x) (#140)
const R_MULT = 2;              // 1R failed outright on BTC (#138)
const HOLD_BARS = 200;         // results flat 50->800, so not a tuned value (#141)
const SLIP_ENTRY_ATR = 0.05;   // #142's MODERATE scenario, not its mildest
const SLIP_STOP_ATR = 0.15;
const SLIP_TARGET_ATR = 0;     // resting limit; generous, ignores queue position
const ITERATIONS = 20000;
const SEED = 42;
const MIN_N_FOR_VERDICT = 60;  // below this the run is INCONCLUSIVE, not a pass
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
// ────────────────────────────────────────────────────────────────────────────────────────────

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const INSTRUMENT = args.instrument || "SOL";

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function atrSeries(candles, length) {
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

async function buildTrades(instrument) {
  const clusters = buildCooccurrenceClusters(loadStructureEvents(instrument), { mult: CLUSTER_MULT });
  const byRung = new Map();
  for (const c of clusters) {
    if (!byRung.has(c.outcomeRung)) byRung.set(c.outcomeRung, []);
    byRung.get(c.outcomeRung).push(c);
  }
  const trades = [];
  for (const [rung, list] of byRung) {
    const candles = await loadCandles(rung, instrument);
    const atr = atrSeries(candles, ATR_LEN);
    const times = candles.map((x) => x.t);
    for (const c of list) {
      let lo = 0, hi = times.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] > c.knownAtTime) { idx = m; hi = m - 1; } else lo = m + 1; }
      if (idx < 0 || idx >= candles.length) continue;
      const a = atr[idx];
      if (!Number.isFinite(a) || a <= 0) continue;
      const side = c.direction === "bullish" ? "long" : "short";
      const risk = ATR_MULT * a;
      const entry = side === "long" ? candles[idx].o + SLIP_ENTRY_ATR * a : candles[idx].o - SLIP_ENTRY_ATR * a;
      const stop = side === "long" ? entry - risk : entry + risk;
      const target = side === "long" ? entry + R_MULT * risk : entry - R_MULT * risk;

      const end = Math.min(candles.length - 1, idx + HOLD_BARS);
      let pnl = null, hours = 0, won = 0;
      for (let j = idx; j <= end; j++) {
        const b = candles[j];
        const hitStop = side === "long" ? b.l <= stop : b.h >= stop;
        const hitTarget = side === "long" ? b.h >= target : b.l <= target;
        if (hitStop) { // stop-first on ambiguity; market fill, slipped hardest
          const fill = side === "long" ? stop - SLIP_STOP_ATR * a : stop + SLIP_STOP_ATR * a;
          pnl = side === "long" ? (fill - entry) / entry : (entry - fill) / entry;
          hours = (b.t - candles[idx].t) / 3600; won = 0; break;
        }
        if (hitTarget) {
          const fill = side === "long" ? target - SLIP_TARGET_ATR * a : target + SLIP_TARGET_ATR * a;
          pnl = side === "long" ? (fill - entry) / entry : (entry - fill) / entry;
          hours = (b.t - candles[idx].t) / 3600; won = 1; break;
        }
      }
      if (pnl === null) { // mark to market at the hold limit -- market exit, slipped like an entry
        if (end <= idx) continue;
        const b = candles[end];
        const fill = side === "long" ? b.c - SLIP_ENTRY_ATR * a : b.c + SLIP_ENTRY_ATR * a;
        pnl = side === "long" ? (fill - entry) / entry : (entry - fill) / entry;
        hours = (b.t - candles[idx].t) / 3600; won = pnl > 0 ? 1 : 0;
      }
      const net = pnl - 2 * TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, hours);
      trades.push({ K: c.K, rung, entryTime: candles[idx].t, net, won });
    }
  }
  return trades.sort((a, b) => a.entryTime - b.entryTime);
}

async function main() {
  console.log(`${"=".repeat(96)}`);
  console.log(`PRE-REGISTERED RUN -- ${INSTRUMENT}`);
  console.log(`Config frozen in skills/ict-smc-trader/PREREGISTRATION-cooccurrence-k3.md (commit 5d5220b),`);
  console.log(`committed before any ${INSTRUMENT} data existed in this repository.`);
  console.log(`K>=3 vs K=1 | ${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}) | hold<=${HOLD_BARS} | MTM | slip ${SLIP_ENTRY_ATR}/${SLIP_STOP_ATR} ATR | taker ${(TAKER * 100).toFixed(3)}%`);
  console.log(`${"=".repeat(96)}`);

  const trades = await buildTrades(INSTRUMENT);
  const k3 = trades.filter((t) => t.K >= 3);
  const k1 = trades.filter((t) => t.K === 1);
  const k2 = trades.filter((t) => t.K === 2);

  const stat = (g) => (g.length ? { n: g.length, win: g.filter((t) => t.won).length / g.length, net: mean(g.map((t) => t.net)) } : null);
  const s3 = stat(k3), s2 = stat(k2), s1 = stat(k1);

  console.log(`\ngroup    n       win%     net%/trade`);
  for (const [lab, s] of [["K=1", s1], ["K=2", s2], ["K>=3", s3]]) {
    if (!s) continue;
    console.log(`${lab.padEnd(8)} ${String(s.n).padStart(5)}  ${(s.win * 100).toFixed(1).padStart(6)}%  ${(s.net * 100).toFixed(4).padStart(10)}%`);
  }

  // Criterion 2: K>=3 minus K=1 gap, circular-shift null over time-ordered trades
  const pool = [...k3.map((t) => ({ ...t, hi: 1 })), ...k1.map((t) => ({ ...t, hi: 0 }))].sort((a, b) => a.entryTime - b.entryTime);
  const vals = pool.map((t) => t.net), lab = pool.map((t) => t.hi);
  const gapOf = (arr) => {
    let sA = 0, nA = 0, sB = 0, nB = 0;
    for (let i = 0; i < arr.length; i++) { if (arr[i]) { sA += vals[i]; nA++; } else { sB += vals[i]; nB++; } }
    return nA && nB ? sA / nA - sB / nB : null;
  };
  const realGap = gapOf(lab);
  const rng = mulberry32(SEED);
  let geq = 0;
  for (let k = 0; k < ITERATIONS; k++) {
    const off = 1 + Math.floor(rng() * (lab.length - 2));
    const cs = lab.map((_, i) => lab[(i + off) % lab.length]);
    const g = gapOf(cs);
    if (g != null && g >= realGap) geq++;
  }
  const p = geq / ITERATIONS;
  console.log(`\nK>=3 minus K=1: gap=${(realGap * 100).toFixed(4)}pp   p(circular-shift)=${p.toFixed(4)}`);

  // ── VERDICT against the criteria declared in advance ─────────────────────────────────────
  const c1 = s3 && s3.net > 0;
  const c2 = realGap > 0 && p < 0.05;
  let verdict;
  if (!s3 || s3.n < MIN_N_FOR_VERDICT) verdict = `INCONCLUSIVE — only ${s3 ? s3.n : 0} K>=3 trades, below the pre-declared floor of ${MIN_N_FOR_VERDICT}`;
  else if (c1 && c2) verdict = "PASS";
  else verdict = `FAIL — criterion 1 (net>0): ${c1 ? "met" : "NOT met"}; criterion 2 (gap>0 and p<0.05): ${c2 ? "met" : "NOT met"}`;

  console.log(`\n${"=".repeat(96)}`);
  console.log(`PRE-DECLARED CRITERIA`);
  console.log(`  1. K>=3 net costed expectancy > 0 ............ ${c1 ? "MET" : "NOT MET"}  (${s3 ? (s3.net * 100).toFixed(4) + "%" : "n/a"})`);
  console.log(`  2. K>=3 minus K=1 gap > 0 at p < 0.05 ........ ${c2 ? "MET" : "NOT MET"}  (gap ${(realGap * 100).toFixed(4)}pp, p=${p.toFixed(4)})`);
  console.log(`  population floor: n(K>=3) >= ${MIN_N_FOR_VERDICT} ................ ${s3 && s3.n >= MIN_N_FOR_VERDICT ? "MET" : "NOT MET"}  (n=${s3 ? s3.n : 0})`);
  console.log(`\n  VERDICT: ${verdict}`);
  console.log(`${"=".repeat(96)}`);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `preregistered_k3_${INSTRUMENT}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify({
    generated_at: new Date().toISOString(), instrument: INSTRUMENT, preregistration_commit: "5d5220b",
    config: { CLUSTER_MULT, ATR_LEN, ATR_MULT, R_MULT, HOLD_BARS, SLIP_ENTRY_ATR, SLIP_STOP_ATR, SLIP_TARGET_ATR, ITERATIONS, SEED, TAKER },
    k1: s1, k2: s2, k3: s3, gap_pp: realGap * 100, p, criterion_1_met: c1, criterion_2_met: c2, verdict,
  }, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

#!/usr/bin/env node
// H-NEST: is the informative multi-timeframe state the LOCATION OF DISAGREEMENT in the ladder,
// rather than any single rung's direction?
//
// ORIGIN. Raised by iapaulo, 2026-08-15: "when the weekly is bullish and the daily is bearish then
// we will be watching the 4h initiate the daily change to bullish and the lower timeframes all
// apply." Formalised in register #131 and tested here for the first time.
//
// WHY THIS IS NOT WHAT #128/#131 MEASURED, AND WHY IT WOULD EXPLAIN THEIR NULLS.
// #128 measured I(Y ; s_rung | coarser rungs) -- the MARGINAL information of each rung's direction.
// If disagreement states and agreement states carry different (or opposite) information, then any
// single rung's marginal information AVERAGES ACROSS BOTH and cancels. A main-effect test is
// structurally incapable of seeing a pattern that lives in the joint alignment configuration. That
// is a specific, mechanical explanation for a null result, not a rationalisation of one.
//
// The register already contains a data point on the same side: #113/#114 found Strategy G fires
// AGAINST the concurrent daily regime, and that trading it WITH the daily trend is statistically no
// better than chance. That is a disagreement state outperforming an agreement state, observed in a
// completely different construction.
//
// ENCODING. At each base bar, with the ladder ordered coarse->fine [1w,1d,4h,3h,2h,1h,15m,5m]:
//   topDir  = direction of the coarsest available rung (1w)
//   D       = agreement depth: how many consecutive rungs from the top share topDir (0..8)
//   boundary= rung index D -- the first rung that DISAGREES, i.e. iapaulo's "initiation rung"
// D is a 9-level variable rather than one bit, which also directly addresses #131's power problem:
// where independent observations are the scarce resource, more information per observation is the
// only lever that does not require more data.
//
// THREE TESTS.
//   T1  I(Y ; D)                 -- does agreement depth carry information about the outcome?
//   T2  outcome by D             -- descriptive: mean signed return in the topDir direction at each
//                                  depth. This is where "disagreement beats agreement" would show.
//   T3  initiation events        -- bars where D INCREASES (the boundary rung flips toward the HTF).
//                                  H-NEST(iii) says this specific transition is the signal.
//
// OUTCOME. Signed return in the topDir direction (positive = the higher-timeframe direction won),
// not a binary sign -- per #131 remedy (b), magnitude extracts more information per observation
// than a coin flip does. Reported both as mean signed return and as a win rate.
//
// NULL. Circular shift of the D series, preserving its (very high) persistence while destroying
// alignment with outcomes -- the same correction that #128 showed changes verdicts entirely.
//
// Usage: node scripts/signal-bus/cross-confluence/nested-disagreement-capacity.js
//        [--instrument=BTC|ETH|POOLED] [--base=15m] [--horizon-bars=20] [--shifts=200]

import { writeFileSync, mkdirSync } from "fs";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { calcATRSeries, computeAdaptiveSuperTrend } from "../../lib/adaptive-supertrend.js";

// DIRECTION SIGN -- corrected 2026-08-16. The AlgoAlpha SuperTrend uses dir === -1 for BULLISH
// (pine line 33: `superTrend := _direction == -1 ? lowerBand : upperBand`, i.e. dir=-1 puts the
// line at the LOWER band, below price, which is an uptrend; line 96 confirms
// `ta.crossunder(dir, 0)` is labelled "Bullish Trend"). The signal bus has always mapped this
// correctly. Every ad-hoc analysis script in this directory originally wrote `dir > 0 ? bullish`,
// which is INVERTED -- verified empirically against ST-vs-price geometry over 19,586 4h bars: the
// bus mapping agrees 100.00% of the time, the `dir > 0` mapping 0.00%. See register #139.

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const INSTRUMENT = args.instrument || "BTC";
const BASE = args.base || "15m";
const HORIZON = parseInt(args["horizon-bars"] || "20", 10);
const SHIFTS = parseInt(args.shifts || "200", 10);
const SEED = parseInt(args.seed || "42", 10);
const ATR_LEN = 10;
const LADDER = [["1w", 604800], ["1d", 86400], ["4h", 14400], ["3h", 10800], ["2h", 7200], ["1h", 3600], ["15m", 900], ["5m", 300]];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// I(Y;D) with Y binarised at zero and D taking 0..8. Plug-in; the circular-shift null carries the
// same bias so the comparison cancels it.
function mutualInfo(yBin, d, idx, dCard) {
  const joint = new Float64Array(dCard * 2), py = new Float64Array(2), pd = new Float64Array(dCard);
  for (const i of idx) { joint[d[i] * 2 + yBin[i]]++; py[yBin[i]]++; pd[d[i]]++; }
  const n = idx.length;
  let mi = 0;
  for (let a = 0; a < dCard; a++) for (let b = 0; b < 2; b++) {
    const j = joint[a * 2 + b];
    if (j === 0) continue;
    mi += (j / n) * Math.log2((j / n) / ((pd[a] / n) * (py[b] / n)));
  }
  return mi;
}

async function buildInstrument(inst) {
  const baseCandles = await loadCandles(BASE, inst);
  const nB = baseCandles.length;

  // Per-rung direction aligned onto the base timeline, available_at enforced: a rung contributes
  // only its last bar that has CLOSED at or before this base bar's open.
  const dirs = [];
  for (const [tf, stepSec] of LADDER) {
    const candles = tf === BASE ? baseCandles : await loadCandles(tf, inst);
    const atr = calcATRSeries(candles, ATR_LEN);
    const { dir } = computeAdaptiveSuperTrend(candles, atr);
    const s = new Int8Array(nB).fill(-1);
    let j = 0;
    for (let i = 0; i < nB; i++) {
      const cutoff = baseCandles[i].t - stepSec;
      while (j + 1 < candles.length && candles[j + 1].t <= cutoff) j++;
      if (candles[j].t <= cutoff && Number.isFinite(dir[j])) s[i] = dir[j] === -1 ? 1 : 0;
    }
    dirs.push(s);
  }

  const D = new Int8Array(nB).fill(-1);
  const topDir = new Int8Array(nB).fill(-1);
  for (let i = 0; i < nB; i++) {
    let ok = true;
    for (const s of dirs) if (s[i] < 0) { ok = false; break; }
    if (!ok) continue;
    topDir[i] = dirs[0][i];
    let d = 0;
    while (d < dirs.length && dirs[d][i] === topDir[i]) d++;
    D[i] = d; // 0 is impossible by construction (rung 0 always agrees with itself); range 1..8
  }

  // Signed return in the topDir direction over HORIZON base bars.
  const ret = new Float64Array(nB).fill(NaN);
  for (let i = 0; i + HORIZON < nB; i++) {
    if (topDir[i] < 0) continue;
    const r = (baseCandles[i + HORIZON].c - baseCandles[i].c) / baseCandles[i].c;
    ret[i] = topDir[i] === 1 ? r : -r;
  }

  return { nB, D, topDir, ret };
}

function analyse(name, sets, rng) {
  // Concatenate instruments; index bookkeeping keeps each instrument's circular shift within its
  // own series so pooling cannot smear one instrument's regimes onto another's outcomes.
  const idx = [], segs = [];
  let offset = 0;
  const Dall = [], retAll = [], topAll = [];
  for (const s of sets) {
    for (let i = 0; i < s.nB; i++) { Dall.push(s.D[i]); retAll.push(s.ret[i]); topAll.push(s.topDir[i]); }
    segs.push({ start: offset, len: s.nB });
    offset += s.nB;
  }
  const total = Dall.length;
  const D = Int8Array.from(Dall);
  const ret = Float64Array.from(retAll);
  const topDir = Int8Array.from(topAll);
  const yBin = new Int8Array(total).fill(-1);
  for (let i = 0; i < total; i++) {
    if (D[i] < 0 || !Number.isFinite(ret[i])) continue;
    yBin[i] = ret[i] > 0 ? 1 : 0;
    idx.push(i);
  }

  console.log(`\n${"=".repeat(100)}`);
  console.log(`${name}  --  n=${idx.length.toLocaleString()} usable base bars, horizon ${HORIZON}x${BASE}`);
  console.log(`${"=".repeat(100)}`);

  // T2 -- descriptive by depth. This is where "disagreement beats agreement" would be visible.
  console.log(`\nT2 -- outcome by agreement depth D (signed toward the WEEKLY direction)`);
  console.log(`  D   meaning                          n         mean ret     win%`);
  const rows = [];
  for (let d = 1; d <= 8; d++) {
    const rowsD = idx.filter((i) => D[i] === d);
    if (rowsD.length === 0) continue;
    const mean = rowsD.reduce((s, i) => s + ret[i], 0) / rowsD.length;
    const win = rowsD.reduce((s, i) => s + (ret[i] > 0 ? 1 : 0), 0) / rowsD.length;
    const meaning = d === 8 ? "whole ladder agrees" : `boundary at ${LADDER[d][0]}`;
    console.log(`  ${d}   ${meaning.padEnd(30)} ${String(rowsD.length).padStart(8)}  ${(mean * 100).toFixed(4).padStart(9)}%  ${(win * 100).toFixed(2).padStart(6)}%`);
    rows.push({ D: d, meaning, n: rowsD.length, mean_ret_pct: mean * 100, win_rate: win });
  }

  // T1 -- does D carry information at all?
  const real = mutualInfo(yBin, D, idx, 9);
  let geq = 0;
  const shifted = new Int8Array(total);
  for (let k = 0; k < SHIFTS; k++) {
    // shift within each instrument segment independently
    for (const seg of segs) {
      const off = 1 + Math.floor(rng() * (seg.len - 2));
      for (let i = 0; i < seg.len; i++) shifted[seg.start + i] = D[seg.start + ((i + off) % seg.len)];
    }
    if (mutualInfo(yBin, shifted, idx, 9) >= real) geq++;
  }
  const p = geq / SHIFTS;
  console.log(`\nT1 -- I(Y ; D) = ${real.toFixed(6)} bits   p=${p.toFixed(4)}${p < 0.05 ? "*" : ""}  (circular-shift null, per-instrument segments)`);

  // T3 -- initiation events: D increases, i.e. the boundary rung flipped toward the HTF direction.
  console.log(`\nT3 -- initiation events (D increases: the boundary rung flips toward the weekly direction)`);
  const initIdx = [];
  for (const i of idx) {
    if (i === 0) continue;
    if (D[i - 1] > 0 && D[i] > D[i - 1] && topDir[i] === topDir[i - 1]) initIdx.push(i);
  }
  const allMean = idx.reduce((s, i) => s + ret[i], 0) / idx.length;
  if (initIdx.length > 30) {
    const iMean = initIdx.reduce((s, i) => s + ret[i], 0) / initIdx.length;
    const iWin = initIdx.reduce((s, i) => s + (ret[i] > 0 ? 1 : 0), 0) / initIdx.length;
    console.log(`  n=${initIdx.length.toLocaleString()}  mean ret=${(iMean * 100).toFixed(4)}%  win=${(iWin * 100).toFixed(2)}%   vs all-bar baseline ${(allMean * 100).toFixed(4)}%`);
    rows.push({ initiation: true, n: initIdx.length, mean_ret_pct: iMean * 100, win_rate: iWin, baseline_pct: allMean * 100 });
  } else {
    console.log(`  n=${initIdx.length} -- too thin to report`);
  }

  return { name, n: idx.length, mi_bits: real, p, baseline_mean_pct: allMean * 100, rows };
}

async function main() {
  const rng = mulberry32(SEED);
  const out = { base: BASE, horizon_bars: HORIZON, shifts: SHIFTS, seed: SEED, results: [] };

  if (INSTRUMENT === "POOLED") {
    const btc = await buildInstrument("BTC");
    const eth = await buildInstrument("ETH");
    out.results.push(analyse("BTC", [btc], rng));
    out.results.push(analyse("ETH", [eth], rng));
    out.results.push(analyse("POOLED (BTC+ETH)", [btc, eth], rng));
  } else {
    out.results.push(analyse(INSTRUMENT, [await buildInstrument(INSTRUMENT)], rng));
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `nested_disagreement_capacity_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify({ generated_at: new Date().toISOString(), ...out }, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

#!/usr/bin/env node
// TOP-DOWN NESTED SCALE CAPACITY -- how much predictive information does each finer timeframe add
// once every coarser timeframe is already known?
//
//   I( Y ; s_k | s_1 .. s_{k-1} )    walked down the ladder  W -> D -> 4H -> 3H -> 2H -> 1H -> 15m -> 5m
//
// WHY THIS EXPERIMENT, AND WHY NOW (2026-08-15).
// Register #126/#127 established saturation on the CROSS-INDICATOR axis: adding a fifth
// price-derived condition to a four-condition price-derived stack added nothing measurable. That
// says nothing about the CROSS-SCALE axis, which is a different question and the one the project's
// largest research thread has been circling for weeks -- rows #31, #38, #59, #61, #68, #69, #71,
// #72, #73, #74, #76, #77, #79, #113: fourteen rows, five independent indicators.
//
// That thread's result is unusually consistent: nested multi-timeframe confirmation is repeatedly
// SIGNIFICANT (#72 is the strongest significance result in the whole line, p=0.0000 pooled) and
// repeatedly COST-BLOCKED (#73, #74, #76, #79 are all failed unblock attempts; only #69's
// boom_nested_boost ever cleared). Real-but-too-thin across five instruments is the signature of
// information that is genuine but DIFFUSE -- which a threshold rule cannot exploit (it must pick
// one cut and discard the rest) but a model integrating many weak signals can.
//
// This script measures that diffuse information directly instead of inferring it, and it does so
// BEFORE the ICT Concepts port so the port's marginal contribution is measurable against a
// baseline rather than asserted. Measuring the increment rather than the level is the same
// discipline that made the seam repair assessable in #127.
//
// STATE VARIABLE. Each rung contributes one binary regime label: Adaptive SuperTrend direction
// (scripts/lib/adaptive-supertrend.js, the same K-means/ATR math used live and in the backtest
// lab). Chosen because it is (a) defined at EVERY bar of EVERY rung, unlike the sparse event
// signals, (b) already validated -- #72 found nested SuperTrend confirmation the strongest result
// of the nested line, and (c) binary, which keeps the conditioning space at 2^k cells: at the
// deepest step that is 256 cells over ~944k bars, ~3,700 samples per cell. Well powered, which
// sparse curated setups (Strategy G, n=558) never are.
//
// LOOK-AHEAD DISCIPLINE (EEH-CITI-1.0 §29 available_at). A rung bar OPENING at T does not close
// until T+step, so its direction is unknowable until then. At base bar t the newest usable rung
// bar is the last one with T <= t - step. This is applied to every rung including the base rung
// itself (5m at bar t uses bar t-1). Getting this wrong is the single most common way a study of
// this shape produces a spectacular and entirely fake result.
//
// NULL HYPOTHESIS -- circular shift, NOT i.i.d. shuffle. Regime labels are massively
// autocorrelated (a SuperTrend direction persists for many bars) and forward returns overlap.
// An i.i.d. permutation destroys that structure and yields a null far too permissive, inflating
// significance. A random CIRCULAR SHIFT of the rung's state series preserves its entire internal
// autocorrelation while destroying only its alignment with the outcome -- the correct null for
// two autocorrelated series. This is a deliberate methodological upgrade over the i.i.d.-style
// permutation used in this project's earlier significance scripts; noted so the difference is not
// mistaken for an inconsistency.
//
// Usage: node scripts/signal-bus/cross-confluence/nested-scale-capacity.js
//        [--instrument=BTC] [--base=5m] [--horizons=12,48,288] [--shifts=200] [--seed=42]

import { writeFileSync, mkdirSync } from "fs";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { calcATRSeries, computeAdaptiveSuperTrend } from "../../lib/adaptive-supertrend.js";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")),
);
const INSTRUMENT = args.instrument || "BTC";
const BASE = args.base || "5m";
const HORIZONS = (args.horizons || "12,48,288").split(",").map(Number); // in BASE bars: 1h, 4h, 1d
const SHIFTS = parseInt(args.shifts || "200", 10);
const SEED = parseInt(args.seed || "42", 10);
// "circular" (default, correct) or "iid" (deliberately WRONG, kept only to quantify how much an
// i.i.d. shuffle inflates significance on autocorrelated series -- see the null-model note above.
// Never use iid for a real finding; it exists purely as a diagnostic against this project's own
// earlier permutation designs.
const NULL_MODEL = args.null || "circular";
const ATR_LEN = 10; // matches scripts/lib/adaptive-supertrend.js

// Coarsest -> finest. This IS the top-down order; the conditioning set grows as we descend.
const LADDER = [
  ["1w", 7 * 86400],
  ["1d", 86400],
  ["4h", 4 * 3600],
  ["3h", 3 * 3600],
  ["2h", 2 * 3600],
  ["1h", 3600],
  ["15m", 900],
  ["5m", 300],
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Conditional mutual information I(Y ; S | C) for binary Y, binary S, and an integer cell id C.
// Plug-in estimator. Bias is not corrected analytically because the circular-shift null carries
// the SAME bias -- comparing real against null cancels it, which is more trustworthy than a
// closed-form correction whose assumptions we would then have to defend.
function conditionalMI(yArr, sArr, cellArr, nCells, idx) {
  // counts[cell][s][y]
  const counts = new Float64Array(nCells * 4);
  for (const i of idx) {
    counts[cellArr[i] * 4 + sArr[i] * 2 + yArr[i]] += 1;
  }
  let mi = 0;
  const total = idx.length;
  for (let c = 0; c < nCells; c++) {
    const base = c * 4;
    const n00 = counts[base], n01 = counts[base + 1], n10 = counts[base + 2], n11 = counts[base + 3];
    const nc = n00 + n01 + n10 + n11;
    if (nc === 0) continue;
    const ns0 = n00 + n01, ns1 = n10 + n11;
    const ny0 = n00 + n10, ny1 = n01 + n11;
    for (const [n, ns, ny] of [[n00, ns0, ny0], [n01, ns0, ny1], [n10, ns1, ny0], [n11, ns1, ny1]]) {
      if (n === 0) continue;
      mi += (nc / total) * (n / nc) * Math.log2((n / nc) / ((ns / nc) * (ny / nc)));
    }
  }
  return mi;
}

async function main() {
  const rng = mulberry32(SEED);
  console.log(`Loading ${INSTRUMENT} ladder...`);

  const baseCandles = await loadCandles(BASE, INSTRUMENT);
  const nBase = baseCandles.length;
  const baseTimes = new Float64Array(nBase);
  const baseClose = new Float64Array(nBase);
  for (let i = 0; i < nBase; i++) { baseTimes[i] = baseCandles[i].t; baseClose[i] = baseCandles[i].c; }

  // Per-rung binary state aligned onto the base timeline under available_at discipline.
  const states = [];
  for (const [tf, stepSec] of LADDER) {
    const candles = tf === BASE ? baseCandles : await loadCandles(tf, INSTRUMENT);
    const atr = calcATRSeries(candles, ATR_LEN);
    const { dir } = computeAdaptiveSuperTrend(candles, atr);

    const s = new Int8Array(nBase).fill(-1); // -1 = not yet available
    let j = 0;
    for (let i = 0; i < nBase; i++) {
      // newest rung bar whose CLOSE (openTime + step) is at or before this base bar's open time
      const cutoff = baseTimes[i] - stepSec;
      while (j + 1 < candles.length && candles[j + 1].t <= cutoff) j++;
      if (candles[j].t <= cutoff && Number.isFinite(dir[j])) s[i] = dir[j] > 0 ? 1 : 0;
    }
    states.push({ tf, s });
    const avail = s.reduce((a, v) => a + (v >= 0 ? 1 : 0), 0);
    console.log(`  ${tf.padEnd(4)} aligned, ${((avail / nBase) * 100).toFixed(1)}% of base bars have an available state`);
  }

  const results = { instrument: INSTRUMENT, base: BASE, horizons: {}, };

  for (const H of HORIZONS) {
    // Outcome: sign of forward return over H base bars.
    const y = new Int8Array(nBase).fill(-1);
    for (let i = 0; i + H < nBase; i++) y[i] = baseClose[i + H] > baseClose[i] ? 1 : 0;

    // Usable rows: outcome defined AND every rung has an available state.
    const idx = [];
    for (let i = 0; i + H < nBase; i++) {
      if (y[i] < 0) continue;
      let ok = true;
      for (const st of states) if (st.s[i] < 0) { ok = false; break; }
      if (ok) idx.push(i);
    }

    console.log(`\n${"=".repeat(96)}`);
    console.log(`HORIZON ${H} ${BASE} bars  (n=${idx.length.toLocaleString()} usable base bars)`);
    console.log(`${"=".repeat(96)}`);
    console.log(`rung   I(Y;s_k | coarser)   as % of H(Y)      p (circular-shift null)   cumulative`);

    // Cell id accumulates the coarser rungs' states as a binary number.
    const cell = new Int32Array(nBase);
    let nCells = 1;
    let cumulative = 0;
    const rows = [];

    // H(Y) over the usable rows, for expressing MI as a fraction of total outcome entropy.
    let ones = 0;
    for (const i of idx) ones += y[i];
    const p1 = ones / idx.length;
    const hY = -(p1 * Math.log2(p1) + (1 - p1) * Math.log2(1 - p1));

    for (const st of states) {
      const real = conditionalMI(y, st.s, cell, nCells, idx);

      // Null draw. circular = preserves the rung's own autocorrelation, destroys only alignment.
      // iid = destroys autocorrelation too, which is WRONG here and inflates significance; kept
      // only as a diagnostic to measure that inflation.
      const shifted = new Int8Array(nBase);
      let geq = 0;
      for (let k = 0; k < SHIFTS; k++) {
        if (NULL_MODEL === "iid") {
          for (let i = 0; i < nBase; i++) shifted[i] = st.s[Math.floor(rng() * nBase)];
        } else {
          const off = 1 + Math.floor(rng() * (nBase - 2));
          for (let i = 0; i < nBase; i++) shifted[i] = st.s[(i + off) % nBase];
        }
        if (conditionalMI(y, shifted, cell, nCells, idx) >= real) geq++;
      }
      const p = geq / SHIFTS;
      cumulative += real;

      rows.push({ tf: st.tf, cmi_bits: real, pct_of_HY: (real / hY) * 100, p, cumulative_bits: cumulative, cells: nCells });
      console.log(
        `${st.tf.padEnd(5)} ${real.toFixed(6).padStart(12)} bits ${((real / hY) * 100).toFixed(3).padStart(10)}%   ${p.toFixed(4)}${p < 0.05 ? "*" : " "}   ${cumulative.toFixed(6).padStart(12)} bits  (${nCells} cells)`,
      );

      // Descend: this rung joins the conditioning set.
      for (const i of idx) cell[i] = cell[i] * 2 + st.s[i];
      nCells *= 2;
      if (nCells > 512) { console.log(`  (conditioning space capped at ${nCells} cells)`); }
    }

    console.log(`\nH(Y) = ${hY.toFixed(6)} bits (base rate ${(p1 * 100).toFixed(2)}% up)`);
    console.log(`Total nested capacity captured = ${cumulative.toFixed(6)} bits = ${((cumulative / hY) * 100).toFixed(3)}% of outcome entropy`);
    results.horizons[H] = { n: idx.length, h_y_bits: hY, base_rate_up: p1, total_bits: cumulative, total_pct_of_HY: (cumulative / hY) * 100, rungs: rows };
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `nested_scale_capacity_${INSTRUMENT}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify({ generated_at: new Date().toISOString(), seed: SEED, shifts: SHIFTS, atr_len: ATR_LEN, state_variable: "adaptive_supertrend_direction", null_model: "circular_shift", ...results }, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

#!/usr/bin/env node
// HTF-AS-CONTEXT, and the incremental information of ICT FVG over the existing stack.
//
// ===========================================================================================
// REVISION OF PRIOR DEFINITION -- corrects register #128's verdict.
// ===========================================================================================
// #128 concluded "the top-down thesis is NOT supported" because I(Y ; s_rung | coarser rungs) was
// indistinguishable from its null at 1w/1d/4h/3h/2h. That conclusion overreached, for four
// reasons, all of which are methodological rather than empirical:
//
//   1. SCALE MISMATCH. #128 measured every rung against forward returns of 1h/4h/1d. Asking
//      whether the WEEKLY regime predicts a ONE-HOUR return is close to meaningless. Each rung
//      must be tested against a horizon proportional to its own bar duration.
//
//   2. WRONG QUANTITY. #128 measured a MAIN EFFECT -- "does HTF state predict direction". The
//      practitioner claim, and the thing the ICT/SMC literature actually asserts, is an
//      INTERACTION: HTF state conditions what a lower-timeframe signal MEANS. #113/#114 already
//      demonstrated this is real for Strategy G, where the daily regime did not predict direction
//      but did change the LTF construction's behaviour -- and inverted it. #128's design had no
//      LTF signal present to interact with, so it could not have detected this.
//
//   3. NO POWER, MISREPORTED AS NO INFORMATION. 1w has ~470 bars in the whole dataset. On a 5m
//      base each weekly state persists ~2,016 bars, so there were ~470 genuinely independent
//      weekly observations, not 722,000. The circular-shift null correctly refused to credit the
//      pseudo-replication -- which means the coarse rungs were UNDERPOWERED, not empty. Absence of
//      evidence was reported as evidence of absence.
//
//   4. LOSSY STATE. One bit of SuperTrend direction discards distance-from-band, time-since-flip
//      and volatility cluster -- plausibly the parts of a weekly regime that carry context.
//
// This script measures the two things #128 should have measured.
//
// M1 -- SCALE-MATCHED MAIN EFFECT. For each rung, compute I(Y ; s) on THAT RUNG'S OWN bar series,
//       with the outcome horizon set to a fixed number of that rung's own bars. A weekly regime is
//       then judged on weekly-scale outcomes. Circular-shift null throughout.
//
// M2 -- HTF AS CONTEXT (the interaction #128 missed). On a 15m base, take an LTF signal (ICT FVG
//       touch, from the #130 port) and measure its information about forward return BOTH pooled
//       and STRATIFIED by higher-timeframe regime. If the LTF signal carries different information
//       in different HTF states, then HTF matters as context even with a main effect of exactly
//       zero -- which is precisely the claim #128 failed to test. The interaction magnitude is
//       I(Y ; signal | HTF) - I(Y ; signal), and a positive value is the thing to look for.
//
// M2 doubles as the incremental-information test for the ICT port: it asks what FVG adds ON TOP OF
// context already available, rather than measuring FVG standalone -- which is the standing lesson
// of #126 (measure the increment, not the level).
//
// Usage: node scripts/signal-bus/cross-confluence/htf-conditioning-capacity.js
//        [--instrument=BTC] [--horizon-bars=20] [--shifts=200] [--seed=42]

import { DatabaseSync } from "node:sqlite";
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
const HORIZON_BARS = parseInt(args["horizon-bars"] || "20", 10); // in each rung's OWN bars
const SHIFTS = parseInt(args.shifts || "200", 10);
const SEED = parseInt(args.seed || "42", 10);
const ATR_LEN = 10;

const LADDER = [["1w", 604800], ["1d", 86400], ["4h", 14400], ["3h", 10800], ["2h", 7200], ["1h", 3600], ["15m", 900], ["5m", 300]];
const ICT_DB = (inst) => new URL(`../../../data/signal-bus/${inst === "BTC" ? "ict.db" : "ict-eth.db"}`, import.meta.url);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// I(Y;S) over paired arrays, both small non-negative integer alphabets. Plug-in estimator; bias is
// left uncorrected because the circular-shift null carries the identical bias and cancels it.
function mutualInfo(y, s, idx, sCard) {
  const joint = new Float64Array(sCard * 2);
  const py = new Float64Array(2), ps = new Float64Array(sCard);
  for (const i of idx) { joint[s[i] * 2 + y[i]]++; py[y[i]]++; ps[s[i]]++; }
  const n = idx.length;
  let mi = 0;
  for (let a = 0; a < sCard; a++) {
    for (let b = 0; b < 2; b++) {
      const j = joint[a * 2 + b];
      if (j === 0) continue;
      mi += (j / n) * Math.log2((j / n) / ((ps[a] / n) * (py[b] / n)));
    }
  }
  return mi;
}

// I(Y;S|C) -- conditional on an integer stratum id.
function conditionalMI(y, s, c, idx, sCard, cCard) {
  const byCell = new Map();
  for (const i of idx) {
    if (!byCell.has(c[i])) byCell.set(c[i], []);
    byCell.get(c[i]).push(i);
  }
  let cmi = 0;
  for (const [, rows] of byCell) {
    cmi += (rows.length / idx.length) * mutualInfo(y, s, rows, sCard);
  }
  return cmi;
}

function pValueCircular(realStat, y, s, idx, sCard, statFn, rng, shifts, seriesLen) {
  const shifted = new Int8Array(seriesLen);
  let geq = 0;
  for (let k = 0; k < shifts; k++) {
    const off = 1 + Math.floor(rng() * (seriesLen - 2));
    for (let i = 0; i < seriesLen; i++) shifted[i] = s[(i + off) % seriesLen];
    if (statFn(shifted) >= realStat) geq++;
  }
  return geq / shifts;
}

async function main() {
  const rng = mulberry32(SEED);
  const out = { instrument: INSTRUMENT, horizon_bars: HORIZON_BARS, shifts: SHIFTS, seed: SEED, m1: [], m2: {} };

  // ── M1: scale-matched main effect, each rung judged on its OWN horizon ───────────────────
  console.log(`${"=".repeat(104)}`);
  console.log(`M1 -- SCALE-MATCHED MAIN EFFECT. Each rung vs a ${HORIZON_BARS}-bar-of-its-own-scale forward return.`);
  console.log(`     #128 tested every rung against 1h/4h/1d outcomes, which is a scale mismatch for the coarse rungs.`);
  console.log(`${"=".repeat(104)}`);
  console.log(`rung   bars     n        I(Y;s) bits    % of H(Y)    p        horizon`);

  for (const [tf, stepSec] of LADDER) {
    const candles = await loadCandles(tf, INSTRUMENT);
    const atr = calcATRSeries(candles, ATR_LEN);
    const { dir } = computeAdaptiveSuperTrend(candles, atr);
    const n = candles.length;
    const s = new Int8Array(n);
    const y = new Int8Array(n).fill(-1);
    for (let i = 0; i < n; i++) s[i] = Number.isFinite(dir[i]) && dir[i] === -1 ? 1 : 0;
    for (let i = 0; i + HORIZON_BARS < n; i++) y[i] = candles[i + HORIZON_BARS].c > candles[i].c ? 1 : 0;

    // Use only bars where the state is warmed up and the outcome exists.
    const idx = [];
    for (let i = 50; i + HORIZON_BARS < n; i++) if (y[i] >= 0) idx.push(i);
    if (idx.length < 100) { console.log(`${tf.padEnd(5)} too thin (n=${idx.length})`); continue; }

    let ones = 0; for (const i of idx) ones += y[i];
    const p1 = ones / idx.length;
    const hY = -(p1 * Math.log2(p1) + (1 - p1) * Math.log2(1 - p1));
    const real = mutualInfo(y, s, idx, 2);
    const p = pValueCircular(real, y, s, idx, 2, (sh) => mutualInfo(y, sh, idx, 2), rng, SHIFTS, n);

    const horizonLabel = `${HORIZON_BARS}x${tf}`;
    console.log(`${tf.padEnd(5)} ${String(n).padStart(7)} ${String(idx.length).padStart(8)} ${real.toFixed(6).padStart(13)} ${((real / hY) * 100).toFixed(3).padStart(11)}%  ${p.toFixed(4)}${p < 0.05 ? "*" : " "}  ${horizonLabel}`);
    out.m1.push({ tf, bars: n, n: idx.length, mi_bits: real, pct_of_HY: (real / hY) * 100, p, effective_independent_obs: Math.floor(idx.length / HORIZON_BARS) });
  }

  // ── M2: HTF as CONTEXT for an LTF signal ────────────────────────────────────────────────
  const BASE = "15m", BASE_STEP = 900;
  const baseCandles = await loadCandles(BASE, INSTRUMENT);
  const nB = baseCandles.length;

  // LTF signal: is price inside an ACTIVE ICT FVG at this bar? +1 bullish, 2 bearish, 0 neither.
  // Only zones already CREATED and not yet broken at bar t are eligible -- available_at discipline.
  const db = new DatabaseSync(ICT_DB(INSTRUMENT), { readOnly: true });
  const zones = db.prepare(
    "SELECT side, top, bottom, created_time, broken_time FROM fvg_zones WHERE timeframe = ? AND kind = 'fvg'",
  ).all(BASE);
  db.close();
  console.log(`\nLoaded ${zones.length.toLocaleString()} ${BASE} FVG zones for the LTF signal.`);

  const sig = new Int8Array(nB); // 0 none, 1 bullish, 2 bearish
  {
    const sorted = [...zones].sort((a, b) => a.created_time - b.created_time);
    let ptr = 0;
    const live = [];
    for (let i = 0; i < nB; i++) {
      const t = baseCandles[i].t, c = baseCandles[i].c;
      while (ptr < sorted.length && sorted[ptr].created_time <= t) live.push(sorted[ptr++]);
      for (let k = live.length - 1; k >= 0; k--) {
        if (live[k].broken_time != null && live[k].broken_time <= t) live.splice(k, 1);
      }
      let v = 0;
      for (const z of live) {
        if (c <= z.top && c >= z.bottom) { v = z.side === "bullish" ? 1 : 2; break; }
      }
      sig[i] = v;
    }
  }

  const y = new Int8Array(nB).fill(-1);
  for (let i = 0; i + HORIZON_BARS < nB; i++) y[i] = baseCandles[i + HORIZON_BARS].c > baseCandles[i].c ? 1 : 0;

  console.log(`\n${"=".repeat(104)}`);
  console.log(`M2 -- HTF AS CONTEXT. Does an LTF FVG-touch signal carry DIFFERENT information in different HTF regimes?`);
  console.log(`     interaction = I(Y ; signal | HTF) - I(Y ; signal).  A positive value means HTF matters as context`);
  console.log(`     even where its MAIN effect is zero -- the claim #128 did not test.`);
  console.log(`${"=".repeat(104)}`);
  console.log(`HTF ctx  I(Y;sig) bits  I(Y;sig|HTF)  interaction   p(interaction)   n`);

  for (const [tf, stepSec] of LADDER) {
    if (stepSec <= BASE_STEP) continue; // context must be strictly higher-timeframe
    const cCandles = await loadCandles(tf, INSTRUMENT);
    const cAtr = calcATRSeries(cCandles, ATR_LEN);
    const { dir } = computeAdaptiveSuperTrend(cCandles, cAtr);

    const ctx = new Int8Array(nB).fill(-1);
    let j = 0;
    for (let i = 0; i < nB; i++) {
      const cutoff = baseCandles[i].t - stepSec; // available_at: last CLOSED higher-TF bar
      while (j + 1 < cCandles.length && cCandles[j + 1].t <= cutoff) j++;
      if (cCandles[j].t <= cutoff && Number.isFinite(dir[j])) ctx[i] = dir[j] === -1 ? 1 : 0;
    }

    const idx = [];
    for (let i = 0; i + HORIZON_BARS < nB; i++) if (y[i] >= 0 && ctx[i] >= 0) idx.push(i);
    if (idx.length < 1000) continue;

    const pooled = mutualInfo(y, sig, idx, 3);
    const conditional = conditionalMI(y, sig, ctx, idx, 3, 2);
    const interaction = conditional - pooled;

    // Null for the interaction: circular-shift the CONTEXT series. This preserves the HTF regime's
    // own persistence while destroying its alignment with the signal/outcome pair, so a spurious
    // interaction produced by autocorrelation alone is correctly credited to the null.
    const shifted = new Int8Array(nB);
    let geq = 0;
    for (let k = 0; k < SHIFTS; k++) {
      const off = 1 + Math.floor(rng() * (nB - 2));
      for (let i = 0; i < nB; i++) shifted[i] = ctx[(i + off) % nB];
      const cond = conditionalMI(y, sig, shifted, idx, 3, 2);
      if (cond - pooled >= interaction) geq++;
    }
    const pInt = geq / SHIFTS;

    console.log(`${tf.padEnd(8)} ${pooled.toFixed(6).padStart(13)} ${conditional.toFixed(6).padStart(13)} ${interaction.toFixed(6).padStart(12)}   ${pInt.toFixed(4)}${pInt < 0.05 ? "*" : " "}        ${idx.length.toLocaleString()}`);
    out.m2[tf] = { pooled_bits: pooled, conditional_bits: conditional, interaction_bits: interaction, p: pInt, n: idx.length };
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `htf_conditioning_capacity_${INSTRUMENT}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify({ generated_at: new Date().toISOString(), ...out }, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

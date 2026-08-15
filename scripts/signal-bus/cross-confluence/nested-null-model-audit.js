#!/usr/bin/env node
// NULL-MODEL AUDIT of the nested-confirmation thread, prompted by register #128.
//
// #128 demonstrated, on a per-bar mutual-information statistic, that swapping ONLY the null model
// -- identical data, identical statistic to six decimals -- flipped the verdict from 0-of-8 rungs
// significant (circular-shift null) to 8-of-8 at p=0.0000 (i.i.d. Fisher-Yates null). The reason
// is that an i.i.d. shuffle destroys autocorrelation the real series has, so the null distribution
// becomes far too narrow and manufactures significance from nothing.
//
// #128 explicitly did NOT claim that result invalidated the trade-based nested findings, because
// their statistic is different: a LABEL permutation over discrete trade events rather than a
// shuffle of a time series. That is a materially more defensible design. It is vulnerable only to
// the extent that the labels CLUSTER IN TIME and outcomes correlate within those clusters -- and
// the size of that effect was unmeasured. This script measures it directly.
//
// TARGET: #72 (`supertrend-flip-nested-significance.js`), chosen because the register calls it
// "the strongest significance result of this session's build-out" and because #128 already
// established SuperTrend as the state variable with the strongest nested prior. If the inflation
// is material anywhere, it should be visible here first.
//
// The observation construction below is a VERBATIM copy of #72's -- same events, same ATR_MULT,
// same fixed-R simulation, same same-direction/price-tolerance/window nesting rule -- so the ONLY
// difference between this script's numbers and #72's is the null. The construction is copied
// rather than imported because #72's helpers are not exported and editing that file would change
// the behaviour of a logged finding.
//
// FOUR NULLS, run on the identical observation set:
//   iid        Fisher-Yates shuffle of the labels. Exactly what #72 does today. Assumes trade
//              outcomes are exchangeable.
//   circular   Circular shift of the time-ordered label sequence. Preserves the label series'
//              ENTIRE autocorrelation structure, destroys only its alignment with outcomes. No
//              tuning parameter, so nothing to choose favourably.
//   block(L)   Time-ordered labels partitioned into contiguous blocks of L observations, then the
//              BLOCK ORDER permuted. Preserves clustering up to scale L. Swept over several L so
//              the reader can see how p behaves as the preserved cluster size grows -- a single
//              block size would be an arbitrary choice.
//
// READING THE OUTPUT: if p is stable across all four nulls, #72's clustering is immaterial and the
// finding stands as logged. If p degrades as blocks lengthen, the i.i.d. null was crediting
// temporal clustering as signal, and the nested thread needs re-stating at the corrected p.
//
// Usage: node scripts/signal-bus/cross-confluence/nested-null-model-audit.js
//        [--iterations=20000] [--r=1.5] [--blocks=10,50,200] [--seed=42]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const ST_DB_PATH = new URL("../../../data/signal-bus/adaptive-supertrend.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const ATR_LEN = 14, ATR_MULT = 0.6, MAX_HOLD_BARS = 200;

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULT = Number(args.r || "1.5");
const BLOCK_SIZES = (args.blocks || "10,50,200").split(",").map(Number);
const PRICE_TOLERANCE_PCT = 0.01;
const NESTED_WINDOW_BARS = 10;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
// ---- verbatim from #72 ----
function atr(candles, length) {
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
function simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice) {
  const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= endCheck; j++) {
    const bar = candles[j];
    const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
    const hitTarget = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
    if (hitStop) return 0;
    if (hitTarget) return 1;
  }
  return null;
}
function checkNesting(eventsByTf, ev, ownTimeframe) {
  const ownIdx = LADDER_KEYS.indexOf(ownTimeframe);
  const slowerTfs = LADDER_KEYS.slice(0, ownIdx);
  const nestedOn = [];
  for (const tf of slowerTfs) {
    const windowSec = NESTED_WINDOW_BARS * BAR_DURATION_SEC[tf];
    const candidates = eventsByTf.get(tf).filter((c) => c.direction === ev.direction);
    const match = candidates.some((c) => {
      if (c.time > ev.time) return false;
      if (ev.time - c.time > windowSec) return false;
      const tol = c.price * PRICE_TOLERANCE_PCT;
      return ev.price - tol <= c.price && c.price <= ev.price + tol;
    });
    if (match) nestedOn.push(tf);
  }
  return nestedOn;
}
// ---- end verbatim ----

// Gap statistic, identical to #72's: winRate(labelled) - winRate(unlabelled).
function gapFor(labels, wins) {
  let wX = 0, nX = 0, wY = 0, nY = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i]) { wX += wins[i]; nX++; } else { wY += wins[i]; nY++; }
  }
  if (nX === 0 || nY === 0) return null;
  return wX / nX - wY / nY;
}

function circularShift(labels, rng) {
  const n = labels.length;
  const off = 1 + Math.floor(rng() * (n - 2));
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = labels[(i + off) % n];
  return out;
}

function blockPermute(labels, L, rng) {
  const n = labels.length;
  const blocks = [];
  for (let i = 0; i < n; i += L) blocks.push(labels.slice(i, i + L));
  const order = shuffle(blocks.map((_, i) => i), rng);
  const out = [];
  for (const bi of order) out.push(...blocks[bi]);
  return out.slice(0, n);
}

function runNull(kind, labels, wins, realGap, iterations, rng, L) {
  let geq = 0, valid = 0;
  for (let k = 0; k < iterations; k++) {
    let perm;
    if (kind === "iid") perm = shuffle(labels, rng);
    else if (kind === "circular") perm = circularShift(labels, rng);
    else perm = blockPermute(labels, L, rng);
    const g = gapFor(perm, wins);
    if (g == null) continue;
    valid++;
    if (g >= realGap) geq++;
  }
  return valid ? geq / valid : null;
}

async function main() {
  console.log("Building #72's observation set verbatim (BTC, 8-rung ladder)...");
  const candlesByTf = {}, atrByTf = {};
  for (const tf of LADDER_KEYS) { candlesByTf[tf] = await loadCandles(tf); atrByTf[tf] = atr(candlesByTf[tf], ATR_LEN); }

  const db = new DatabaseSync(ST_DB_PATH, { readOnly: true });
  const eventsByTf = new Map();
  for (const tf of LADDER_KEYS) eventsByTf.set(tf, db.prepare("SELECT bar_idx, time, price, direction FROM events WHERE timeframe = ?").all(tf));
  db.close();

  const obs = [];
  for (const tf of LADDER_KEYS) {
    const candles = candlesByTf[tf], atr14 = atrByTf[tf];
    for (const ev of eventsByTf.get(tf)) {
      const entryIdx = ev.bar_idx + 1;
      if (entryIdx >= candles.length) continue;
      const atrAtSignal = atr14[ev.bar_idx];
      if (!Number.isFinite(atrAtSignal) || atrAtSignal <= 0) continue;
      const side = ev.direction === "bullish" ? "long" : "short";
      const entryPrice = candles[entryIdx].o;
      const risk = ATR_MULT * atrAtSignal;
      const stop = side === "long" ? entryPrice - risk : entryPrice + risk;
      const target = side === "long" ? entryPrice + R_MULT * risk : entryPrice - R_MULT * risk;
      const outcome = simulateFixedR(candles, entryIdx, side, stop, target);
      if (outcome == null) continue;
      obs.push({ time: ev.time, timeframe: tf, nested: checkNesting(eventsByTf, ev, tf).length > 0, win: outcome });
    }
  }

  const RESULTS = { r_multiple: R_MULT, iterations: ITERATIONS, seed: SEED, block_sizes: BLOCK_SIZES, groups: {} };

  function auditGroup(name, subset) {
    // Time-ordering is what makes block/circular nulls meaningful -- without it "contiguous" has
    // no temporal meaning and the block null degenerates toward the i.i.d. one.
    const sorted = [...subset].sort((a, b) => a.time - b.time);
    const labels = sorted.map((o) => o.nested);
    const wins = sorted.map((o) => o.win);
    const realGap = gapFor(labels, wins);
    if (realGap == null) { console.log(`${name.padEnd(10)} (one group empty, skipped)`); return; }

    const nNested = labels.filter(Boolean).length;
    const row = { n: sorted.length, n_nested: nNested, n_solo: sorted.length - nNested, real_gap_pts: realGap * 100, p: {} };

    const parts = [];
    for (const kind of ["iid", "circular"]) {
      const p = runNull(kind, labels, wins, realGap, ITERATIONS, mulberry32(SEED), null);
      row.p[kind] = p;
      parts.push(`${kind}=${p.toFixed(4)}${p < 0.05 ? "*" : " "}`);
    }
    for (const L of BLOCK_SIZES) {
      const p = runNull("block", labels, wins, realGap, ITERATIONS, mulberry32(SEED), L);
      row.p[`block${L}`] = p;
      parts.push(`blk${L}=${p.toFixed(4)}${p < 0.05 ? "*" : " "}`);
    }
    console.log(`${name.padEnd(10)} n=${String(sorted.length).padStart(6)} (nest=${String(nNested).padStart(5)}) gap=${(realGap * 100).toFixed(2).padStart(6)}pts   ${parts.join("  ")}`);
    RESULTS.groups[name] = row;
  }

  console.log(`\n${"=".repeat(112)}`);
  console.log(`NULL-MODEL AUDIT of #72 (SuperTrend nested confirmation) @ ${R_MULT}R -- ${ITERATIONS} draws per null`);
  console.log(`iid = what #72 uses today.  circular/block = autocorrelation-preserving alternatives.`);
  console.log(`${"=".repeat(112)}`);
  console.log(`group        n        (nested)   real gap    p under each null`);

  auditGroup("POOLED", obs);
  // Per-timeframe removes a real confound the pooled test carries: 1w events can never be nested
  // (no slower rung exists), so the solo group is structurally enriched with slow-timeframe trades.
  for (const tf of LADDER_KEYS) {
    const sub = obs.filter((o) => o.timeframe === tf);
    if (sub.length > 50) auditGroup(tf, sub);
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `nested_null_model_audit_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify({ generated_at: new Date().toISOString(), target: "#72 supertrend-flip-nested-significance", ...RESULTS }, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

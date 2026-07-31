#!/usr/bin/env node
// The properly-gated divergence test (2026-07-31), built after iapaulo's pushback that the naive
// forward-return-significance.js result (which fires on EVERY divergence with no filtering) can't
// represent how divergence is actually traded. Elite/professional use gates a divergence signal
// three ways before acting on it, and this test builds all three, stratified so each gate's
// individual contribution is visible, not just the fully-stacked result:
//
//   1. LOCATION -- does the divergence coincide with independent structural significance (an
//      active, same-side SMC order block), not just any random price? Only meaningful for REGULAR
//      divergence (a reversal claim, which should matter most at a level the market already marked).
//   2. TREND CONTEXT -- for HIDDEN divergence specifically (a continuation claim: valid only during
//      an established trend's pullback), is price actually on the correct side of a longer moving
//      average -- i.e., is there a trend to continue? Regular divergence doesn't need this gate by
//      the same theory (it's an exhaustion claim, not a continuation claim).
//   3. CONFIRMATION -- don't enter on the bar the divergence prints (the raw event is a warning,
//      not a trigger). Require price to actually break the pivot-to-confirmation window's own
//      high/low in the predicted direction within CONFIRM_WINDOW bars; if it never does, the trade
//      never triggers (discarded, not counted as a loss -- no confirmation means no entry, which is
//      the entire point of gating).
//   4. OSCILLATOR AGREEMENT -- does a same-side Divergence-for-Many zone exist within a TIGHT time
//      window (unlike the earlier "ever in 9 years" confluence check that iapaulo correctly flagged
//      as too loose to mean anything) -- a genuine multi-oscillator-family agreement signal.
//
// Forward return is measured from the CONFIRMATION bar (not the divergence bar) -- operationalizing
// "enter on confirmation." Same baseline discipline as forward-return-significance.js: randomly
// sampled bars, randomly assigned a side, same forward window, so general trend drift in this
// mostly-uptrending BTC history is controlled for rather than compared against a naive 50%.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/gated-divergence-significance.js

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const CIPHERB_DB = new URL("../../../data/signal-bus/vmc-cipher-b.db", import.meta.url);
const SMC_DB = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const DIV_DB = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);

const FORWARD_BARS = [5, 10, 20, 40];
const CONFIRM_WINDOW = 5; // bars allowed for price to break the pivot window before the signal is discarded as unconfirmed
const TREND_MA_LEN = 50; // simple trend-context proxy for hidden divergence's continuation claim
const OSC_AGREEMENT_WINDOW_SEC = 24 * 3600; // tightened from the earlier 2-day "confluence" check
const LADDER = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

function sma(values, length) {
  const out = new Array(values.length).fill(NaN);
  for (let i = length - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) sum += values[j];
    out[i] = sum / length;
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - p;
}
function mean(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }
function stderr(arr) {
  const m = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance / arr.length);
}
function pctCorrect(arr) { return arr.filter((x) => x > 0).length / arr.length; }

async function main() {
  const cbDb = new DatabaseSync(CIPHERB_DB, { readOnly: true });
  const zones = cbDb.prepare(`SELECT timeframe, side, kind, price, created_bar_idx, confirmed_bar_idx, confirmed_time FROM zones`).all();
  cbDb.close();

  const smcDb = new DatabaseSync(SMC_DB, { readOnly: true });
  const orderBlocks = smcDb.prepare(`SELECT side, bar_high, bar_low, created_time, mitigated_time FROM order_blocks`).all();
  smcDb.close();

  const divDb = new DatabaseSync(DIV_DB, { readOnly: true });
  const divZones = divDb.prepare(`SELECT side, price, confirmed_time FROM zones`).all();
  divDb.close();
  const divBySide = { bullish: divZones.filter((z) => z.side === "bullish"), bearish: divZones.filter((z) => z.side === "bearish") };

  function hasLocationGate(side, price, atTime) {
    for (const ob of orderBlocks) {
      if (ob.side !== side) continue;
      if (ob.created_time > atTime) continue;
      if (ob.mitigated_time != null && ob.mitigated_time <= atTime) continue;
      if (price >= ob.bar_low && price <= ob.bar_high) return true;
    }
    return false;
  }
  function hasOscillatorAgreement(side, price, atTime) {
    const tol = price * 0.002;
    for (const dz of divBySide[side]) {
      if (Math.abs(dz.confirmed_time - atTime) > OSC_AGREEMENT_WINDOW_SEC) continue;
      if (Math.abs(dz.price - price) <= tol) return true;
    }
    return false;
  }

  const byTf = new Map();
  for (const z of zones) { if (!byTf.has(z.timeframe)) byTf.set(z.timeframe, []); byTf.get(z.timeframe).push(z); }

  // Buckets, keyed by kind ('regular'|'hidden'), each holding arrays per gate-stack level.
  const buckets = {
    regular: { none: {}, confirmedOnly: {}, confirmedPlusLocation: {}, confirmedPlusLocationPlusOsc: {} },
    hidden: { none: {}, confirmedOnly: {}, confirmedPlusTrend: {}, confirmedPlusTrendPlusOsc: {} },
  };
  for (const kind of ["regular", "hidden"]) for (const bucket of Object.values(buckets[kind])) for (const N of FORWARD_BARS) bucket[N] = [];

  const baselineByKind = { regular: {}, hidden: {} };
  for (const kind of ["regular", "hidden"]) for (const N of FORWARD_BARS) baselineByKind[kind][N] = [];
  const rng = mulberry32(42);

  let totalEvents = 0, totalConfirmed = 0;

  for (const tf of LADDER) {
    const tfZones = byTf.get(tf);
    if (!tfZones || tfZones.length === 0) continue;
    const candles = await loadCandles(tf);
    const n = candles.length;
    const closes = candles.map((c) => c.c);
    const trendMA = sma(closes, TREND_MA_LEN);

    for (const z of tfZones) {
      totalEvents++;
      const pivotIdx = z.created_bar_idx, confirmIdx = z.confirmed_bar_idx;
      if (pivotIdx < 0 || confirmIdx >= n) continue;

      // Baseline mean signed return, unfiltered raw event (entering AT the divergence bar) -- 'none' bucket.
      for (const N of FORWARD_BARS) {
        if (confirmIdx + N >= n) continue;
        const raw = (candles[confirmIdx + N].c - candles[confirmIdx].c) / candles[confirmIdx].c;
        buckets[z.kind].none[N].push(z.side === "bearish" ? -raw : raw);
      }

      // Confirmation gate: does price break the [pivotIdx, confirmIdx] window's own high/low in
      // the predicted direction within CONFIRM_WINDOW bars after confirmIdx?
      let windowLow = Infinity, windowHigh = -Infinity;
      for (let k = pivotIdx; k <= confirmIdx; k++) { windowLow = Math.min(windowLow, candles[k].l); windowHigh = Math.max(windowHigh, candles[k].h); }
      let confirmationBarIdx = null;
      for (let k = confirmIdx + 1; k <= Math.min(confirmIdx + CONFIRM_WINDOW, n - 1); k++) {
        if (z.side === "bearish" && candles[k].c < windowLow) { confirmationBarIdx = k; break; }
        if (z.side === "bullish" && candles[k].c > windowHigh) { confirmationBarIdx = k; break; }
      }
      if (confirmationBarIdx == null) continue; // never confirmed -- discarded, not a loss
      totalConfirmed++;

      // Entry = the confirmation bar itself (NOT the original divergence bar). This is the design
      // that avoids look-ahead: an earlier attempt at "fixing" this measured return from confirmIdx
      // while filtering on whether price broke the window within the next CONFIRM_WINDOW bars --
      // for the N=CONFIRM_WINDOW forward test that's the SAME bars used to build the filter,
      // producing a near-tautological 80%+ "edge" that evaporates on inspection. Entering fresh at
      // confirmationBarIdx and measuring a genuinely NEW forward window from there has no such
      // overlap -- whatever this design shows is the real result, not an artifact.
      const entryIdx = confirmationBarIdx;
      const entryClose = candles[entryIdx].c;
      const forwardSigned = {};
      let hasAllForward = true;
      for (const N of FORWARD_BARS) {
        if (entryIdx + N >= n) { hasAllForward = false; continue; }
        const raw = (candles[entryIdx + N].c - entryClose) / entryClose;
        forwardSigned[N] = z.side === "bearish" ? -raw : raw;
      }
      for (const N of FORWARD_BARS) if (forwardSigned[N] !== undefined) buckets[z.kind].confirmedOnly[N].push(forwardSigned[N]);

      if (z.kind === "regular") {
        const location = hasLocationGate(z.side, z.price, z.confirmed_time);
        if (location) {
          for (const N of FORWARD_BARS) if (forwardSigned[N] !== undefined) buckets.regular.confirmedPlusLocation[N].push(forwardSigned[N]);
          const osc = hasOscillatorAgreement(z.side, z.price, z.confirmed_time);
          if (osc) for (const N of FORWARD_BARS) if (forwardSigned[N] !== undefined) buckets.regular.confirmedPlusLocationPlusOsc[N].push(forwardSigned[N]);
        }
      } else {
        const ma = trendMA[confirmIdx];
        const trendOk = !Number.isNaN(ma) && ((z.side === "bullish" && candles[confirmIdx].c > ma) || (z.side === "bearish" && candles[confirmIdx].c < ma));
        if (trendOk) {
          for (const N of FORWARD_BARS) if (forwardSigned[N] !== undefined) buckets.hidden.confirmedPlusTrend[N].push(forwardSigned[N]);
          const osc = hasOscillatorAgreement(z.side, z.price, z.confirmed_time);
          if (osc) for (const N of FORWARD_BARS) if (forwardSigned[N] !== undefined) buckets.hidden.confirmedPlusTrendPlusOsc[N].push(forwardSigned[N]);
        }
      }
    }

    // Baseline: same count as raw events on this timeframe/kind, random bar + random side, same forward windows.
    for (const kind of ["regular", "hidden"]) {
      const count = tfZones.filter((z) => z.kind === kind).length;
      const maxN = Math.max(...FORWARD_BARS);
      for (let s = 0; s < count; s++) {
        const i = Math.floor(rng() * (n - maxN - 1));
        const side = rng() < 0.5 ? "bearish" : "bullish";
        for (const N of FORWARD_BARS) {
          const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
          baselineByKind[kind][N].push(side === "bearish" ? -raw : raw);
        }
      }
    }
  }

  console.log(`Total Cipher B divergence events: ${totalEvents}, confirmed within ${CONFIRM_WINDOW} bars: ${totalConfirmed} (${(totalConfirmed / totalEvents * 100).toFixed(1)}%)\n`);

  function report(kind, bucketName, arr, baselineArr) {
    if (arr.length < 30) { console.log(`  ${bucketName}: n=${arr.length} (too thin to test)`); return; }
    const evMean = mean(arr), baseMean = mean(baselineArr.slice(0, arr.length));
    const se = Math.sqrt(stderr(arr) ** 2 + stderr(baselineArr) ** 2);
    const z = (evMean - baseMean) / se;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    console.log(`  ${bucketName.padEnd(32)} n=${String(arr.length).padEnd(6)} mean=${(evMean * 100).toFixed(3)}%  correct-dir=${(pctCorrect(arr) * 100).toFixed(1)}%  z=${z.toFixed(2)}  p=${p.toFixed(4)} ${p < 0.05 ? "(significant)" : ""}`);
  }

  for (const kind of ["regular", "hidden"]) {
    console.log(`=== ${kind.toUpperCase()} divergence ===`);
    for (const N of FORWARD_BARS) {
      console.log(`--- forward ${N} bars ---`);
      const stack = kind === "regular"
        ? [["no gates (raw, replicate of forward-return-significance.js)", buckets.regular.none[N]], ["confirmed only", buckets.regular.confirmedOnly[N]], ["confirmed + SMC location", buckets.regular.confirmedPlusLocation[N]], ["confirmed + location + osc-agreement", buckets.regular.confirmedPlusLocationPlusOsc[N]]]
        : [["no gates (raw)", buckets.hidden.none[N]], ["confirmed only", buckets.hidden.confirmedOnly[N]], ["confirmed + trend context", buckets.hidden.confirmedPlusTrend[N]], ["confirmed + trend + osc-agreement", buckets.hidden.confirmedPlusTrendPlusOsc[N]]];
      for (const [name, arr] of stack) report(kind, name, arr, baselineByKind[kind][N]);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

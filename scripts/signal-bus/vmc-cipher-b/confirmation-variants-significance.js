#!/usr/bin/env node
// Two better-motivated confirmation designs, requested directly by iapaulo after
// gated-divergence-significance.js's price-break confirmation turned out to REVERSE the raw
// signal's edge (46.3% vs. 53.9% correct-direction at 5 bars) rather than improve it -- the
// diagnosis there was that a full price-range breakout is an EXPENSIVE confirmation: by the time
// it fires, a real chunk of the move is already spent, so entering there buys the tail of that
// initial thrust right where it's likely to pause.
//
// Both variants below follow the SAME non-overlapping-window discipline that price-break
// confirmation got right on its second attempt (after a first, wrongly "fixed" version introduced
// a look-ahead tautology by measuring return over the same bars used to build the filter): detect
// the entry trigger in one window, then measure a completely FRESH forward-return window starting
// at that trigger bar's own close. Whatever these designs show is the real result.
//
//   A. OSCILLATOR RECROSS -- a cheaper, earlier confirmation than a price breakout: does wt1 cross
//      back over wt2 in the divergence's implied direction (the indicator's own built-in
//      buy/sell-dot mechanism, wtCross+wtCrossUp/Down) within CONFIRM_WINDOW bars after the
//      divergence confirms? This can fire on the SAME bar the divergence itself confirms (the
//      fractal detection and a WT cross are different mechanisms, no structural reason they can't
//      coincide) -- included from confirmIdx itself, not confirmIdx+1, since there's no
//      overlapping-window risk here (a cross event is a single-bar, not a look-back range).
//
//   B. PULLBACK-AFTER-BREAKOUT -- entering on a retracement into the price-break confirmation
//      (from the original test) instead of chasing the breakout bar itself. After the breakout
//      (confirmationBarIdx from the price-break test), scan forward up to PULLBACK_WINDOW bars for
//      the first close that has retraced RETRACE_FRACTION of the breakout move back toward the
//      origin, WITHOUT having already closed beyond the original pivot window's opposite boundary
//      (which would mean the setup invalidated, not just pulled back). If neither happens in the
//      window, the event is discarded -- no valid retest, no entry, same discipline as "never
//      confirmed" in the original test.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/confirmation-variants-significance.js

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeWaveTrend } from "./calc.js";

const CIPHERB_DB = new URL("../../../data/signal-bus/vmc-cipher-b.db", import.meta.url);
const FORWARD_BARS = [5, 10, 20, 40];
const CONFIRM_WINDOW = 5; // same window used by the price-break test, for direct comparability
const PULLBACK_WINDOW = 10; // bars allowed to wait for a retest after a confirmed breakout
const RETRACE_FRACTION = 0.3; // disclosed, round-number choice -- not fit to the data
const LADDER = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

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
  // EXCLUDES 'regular_add' (the previously-missing "2nd WT Regular Divergence" detector added
  // 2026-08-01, see calc.js's header note and ARCHITECTURE.md §33) -- kept out of scope here rather
  // than crashing on the untested third kind; the oscillator-recross/pullback designs below COULD
  // reasonably extend to it later, just not needed to verify this script's original finding survives.
  const cbDb = new DatabaseSync(CIPHERB_DB, { readOnly: true });
  const zones = cbDb.prepare(`SELECT timeframe, side, kind, price, created_bar_idx, confirmed_bar_idx FROM zones WHERE kind != 'regular_add'`).all();
  cbDb.close();

  const byTf = new Map();
  for (const z of zones) { if (!byTf.has(z.timeframe)) byTf.set(z.timeframe, []); byTf.get(z.timeframe).push(z); }

  const buckets = { regular: { raw: {}, oscRecross: {}, pullback: {} }, hidden: { raw: {}, oscRecross: {}, pullback: {} } };
  for (const kind of ["regular", "hidden"]) for (const b of Object.values(buckets[kind])) for (const N of FORWARD_BARS) b[N] = [];
  const baselineByKind = { regular: {}, hidden: {} };
  for (const kind of ["regular", "hidden"]) for (const N of FORWARD_BARS) baselineByKind[kind][N] = [];
  const rng = mulberry32(42);

  let oscConfirmedCount = 0, pullbackConfirmedCount = 0, totalEvents = 0;

  for (const tf of LADDER) {
    const tfZones = byTf.get(tf);
    if (!tfZones || tfZones.length === 0) continue;
    const candles = await loadCandles(tf);
    const n = candles.length;
    const { wt1, wt2 } = computeWaveTrend(candles);

    function freshForwardReturns(entryIdx, side) {
      const entryClose = candles[entryIdx].c;
      const out = {};
      for (const N of FORWARD_BARS) {
        if (entryIdx + N >= n) continue;
        const raw = (candles[entryIdx + N].c - entryClose) / entryClose;
        out[N] = side === "bearish" ? -raw : raw;
      }
      return out;
    }

    for (const z of tfZones) {
      totalEvents++;
      const pivotIdx = z.created_bar_idx, confirmIdx = z.confirmed_bar_idx;
      if (pivotIdx < 0 || confirmIdx >= n) continue;

      // raw baseline (replicate, for reference in this run's own numbers)
      const rawReturns = freshForwardReturns(confirmIdx, z.side);
      for (const N of FORWARD_BARS) if (rawReturns[N] !== undefined) buckets[z.kind].raw[N].push(rawReturns[N]);

      // ── A. Oscillator recross ──────────────────────────────────────────
      let oscEntryIdx = null;
      for (let k = confirmIdx; k <= Math.min(confirmIdx + CONFIRM_WINDOW, n - 1); k++) {
        if (k === 0 || Number.isNaN(wt1[k]) || Number.isNaN(wt2[k]) || Number.isNaN(wt1[k - 1]) || Number.isNaN(wt2[k - 1])) continue;
        const crossedDown = wt1[k - 1] >= wt2[k - 1] && wt1[k] < wt2[k];
        const crossedUp = wt1[k - 1] <= wt2[k - 1] && wt1[k] > wt2[k];
        if (z.side === "bearish" && crossedDown) { oscEntryIdx = k; break; }
        if (z.side === "bullish" && crossedUp) { oscEntryIdx = k; break; }
      }
      if (oscEntryIdx != null) {
        oscConfirmedCount++;
        const rets = freshForwardReturns(oscEntryIdx, z.side);
        for (const N of FORWARD_BARS) if (rets[N] !== undefined) buckets[z.kind].oscRecross[N].push(rets[N]);
      }

      // ── B. Pullback after price-break confirmation ─────────────────────
      let windowLow = Infinity, windowHigh = -Infinity;
      for (let k = pivotIdx; k <= confirmIdx; k++) { windowLow = Math.min(windowLow, candles[k].l); windowHigh = Math.max(windowHigh, candles[k].h); }
      let breakoutIdx = null;
      for (let k = confirmIdx + 1; k <= Math.min(confirmIdx + CONFIRM_WINDOW, n - 1); k++) {
        if (z.side === "bearish" && candles[k].c < windowLow) { breakoutIdx = k; break; }
        if (z.side === "bullish" && candles[k].c > windowHigh) { breakoutIdx = k; break; }
      }
      if (breakoutIdx != null) {
        const originClose = candles[confirmIdx].c;
        const breakoutClose = candles[breakoutIdx].c;
        const moveSize = Math.abs(breakoutClose - originClose);
        const retraceTarget = z.side === "bearish" ? breakoutClose + RETRACE_FRACTION * moveSize : breakoutClose - RETRACE_FRACTION * moveSize;
        const invalidationLevel = z.side === "bearish" ? windowHigh : windowLow;
        let pullbackIdx = null, invalidated = false;
        for (let k = breakoutIdx + 1; k <= Math.min(breakoutIdx + PULLBACK_WINDOW, n - 1); k++) {
          if (z.side === "bearish" && candles[k].c > invalidationLevel) { invalidated = true; break; }
          if (z.side === "bullish" && candles[k].c < invalidationLevel) { invalidated = true; break; }
          if (z.side === "bearish" && candles[k].c >= retraceTarget) { pullbackIdx = k; break; }
          if (z.side === "bullish" && candles[k].c <= retraceTarget) { pullbackIdx = k; break; }
        }
        if (!invalidated && pullbackIdx != null) {
          pullbackConfirmedCount++;
          const rets = freshForwardReturns(pullbackIdx, z.side);
          for (const N of FORWARD_BARS) if (rets[N] !== undefined) buckets[z.kind].pullback[N].push(rets[N]);
        }
      }
    }

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

  console.log(`Total events: ${totalEvents}`);
  console.log(`Oscillator-recross confirmed within ${CONFIRM_WINDOW} bars: ${oscConfirmedCount} (${(oscConfirmedCount / totalEvents * 100).toFixed(1)}%)`);
  console.log(`Pullback-after-breakout confirmed within ${CONFIRM_WINDOW}+${PULLBACK_WINDOW} bars: ${pullbackConfirmedCount} (${(pullbackConfirmedCount / totalEvents * 100).toFixed(1)}%)\n`);

  function report(bucketName, arr, baselineArr) {
    if (arr.length < 30) { console.log(`  ${bucketName}: n=${arr.length} (too thin to test)`); return; }
    const evMean = mean(arr), baseMean = mean(baselineArr.slice(0, arr.length));
    const se = Math.sqrt(stderr(arr) ** 2 + stderr(baselineArr) ** 2);
    const z = (evMean - baseMean) / se;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    console.log(`  ${bucketName.padEnd(24)} n=${String(arr.length).padEnd(6)} mean=${(evMean * 100).toFixed(3)}%  correct-dir=${(pctCorrect(arr) * 100).toFixed(1)}%  z=${z.toFixed(2)}  p=${p.toFixed(4)} ${p < 0.05 ? "(significant)" : ""}`);
  }

  for (const kind of ["regular", "hidden"]) {
    console.log(`=== ${kind.toUpperCase()} divergence ===`);
    for (const N of FORWARD_BARS) {
      console.log(`--- forward ${N} bars ---`);
      report("raw (this run's baseline)", buckets[kind].raw[N], baselineByKind[kind][N]);
      report("A: oscillator recross", buckets[kind].oscRecross[N], baselineByKind[kind][N]);
      report("B: pullback after breakout", buckets[kind].pullback[N], baselineByKind[kind][N]);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

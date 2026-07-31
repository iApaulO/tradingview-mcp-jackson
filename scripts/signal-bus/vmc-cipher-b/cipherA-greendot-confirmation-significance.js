#!/usr/bin/env node
// Phase 6 of the video-driven plan: does Cipher A's own "green dot" (longEma/shortEma EMA
// crossover) confirm a same-side Cipher B buySignal/sellSignal, the way the video uses it (9:41:
// "I prefer Cipher B green dots for entries, I use the green dots on Cipher A as more of a
// confirmation")? Tested on 5-minute (Phase 1's real, replicated base signal), same methodology
// and window structure as the yellow-X veto test (§22): exact same bar, then widened windows,
// since Cipher A's green dot (~1 per 29 bars on 5m) is comparably-scaled to Cipher B's buySignal
// (~1 per 21 bars), not as rare as yellowCross was.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/cipherA-greendot-confirmation-significance.js

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeWtCrossSignals } from "./calc.js";
import { computeGreenDot, computeEmaRegime } from "../vmc-cipher-a/calc.js";

const FORWARD_BARS = [5, 10, 20, 40];
const TF = "5m";
const WINDOWS = [0, 3, 10];

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
  const candles = await loadCandles(TF);
  const n = candles.length;
  const { events: baseEvents } = computeWtCrossSignals(candles);
  const { events: gdEvents } = computeGreenDot(candles);
  console.log(`${TF}: ${baseEvents.length} Cipher B buySignal/sellSignal events, ${gdEvents.length} Cipher A green-dot events\n`);

  const gdBySide = { bullish: gdEvents.filter((e) => e.side === "bullish").map((e) => e.barIdx).sort((a, b) => a - b), bearish: gdEvents.filter((e) => e.side === "bearish").map((e) => e.barIdx).sort((a, b) => a - b) };
  // BUG CAUGHT before trusting the result (2026-07-31): the original version used Math.abs(b -
  // barIdx) <= window, which lets a Cipher A dot occurring AFTER the Cipher B signal count as
  // "confirming" it -- look-ahead, since a dot forming later is itself evidence the anticipated
  // move already happened, contaminating the forward-return measurement being compared against it.
  // Produced an 84-89% correct-direction reading with z-scores in the 30s-40s -- far beyond
  // anything real elsewhere in this project, which is what triggered the check. Fixed: only a dot
  // AT OR BEFORE the signal bar counts, matching the past-only discipline already used correctly
  // in the multi-timeframe stacking test (§21).
  function nearGreenDot(side, barIdx, window) {
    const list = gdBySide[side];
    for (const b of list) {
      if (b > barIdx) break; // future dot -- does not count, no look-ahead
      if (barIdx - b <= window) return true;
    }
    return false;
  }

  const rng = mulberry32(42);
  const maxN = Math.max(...FORWARD_BARS);
  function forwardReturns(list) {
    const out = {}; for (const N of FORWARD_BARS) out[N] = [];
    for (const e of list) {
      const i = e.confirmedBarIdx;
      for (const N of FORWARD_BARS) {
        if (i + N >= n) continue;
        const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
        out[N].push(e.side === "bearish" ? -raw : raw);
      }
    }
    return out;
  }
  const baseline = {}; for (const N of FORWARD_BARS) baseline[N] = [];
  for (let s = 0; s < baseEvents.length; s++) {
    const i = Math.floor(rng() * (n - maxN - 1));
    const side = rng() < 0.5 ? "bearish" : "bullish";
    for (const N of FORWARD_BARS) {
      const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
      baseline[N].push(side === "bearish" ? -raw : raw);
    }
  }

  function report(label, arr, baselineArr) {
    if (arr.length < 30) { console.log(`    ${label}: n=${arr.length} (too thin to test)`); return; }
    const evMean = mean(arr), baseMean = mean(baselineArr);
    const se = Math.sqrt(stderr(arr) ** 2 + stderr(baselineArr) ** 2);
    const z = (evMean - baseMean) / se;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    console.log(`    ${label.padEnd(24)} n=${String(arr.length).padEnd(6)} mean=${(evMean * 100).toFixed(3)}%  correct-dir=${(pctCorrect(arr) * 100).toFixed(1)}%  z=${z.toFixed(2)}  p=${p.toFixed(4)} ${p < 0.05 ? "(significant)" : ""}`);
  }

  for (const window of WINDOWS) {
    const confirmed = baseEvents.filter((e) => nearGreenDot(e.side, e.confirmedBarIdx, window));
    const unconfirmed = baseEvents.filter((e) => !nearGreenDot(e.side, e.confirmedBarIdx, window));
    console.log(`window=+/-${window} bars: confirmed n=${confirmed.length}, unconfirmed n=${unconfirmed.length}`);
    for (const N of FORWARD_BARS) {
      console.log(`  N=${N}:`);
      report("unconfirmed (no Cipher A dot)", forwardReturns(unconfirmed)[N], baseline[N]);
      report("confirmed (Cipher A dot nearby)", forwardReturns(confirmed)[N], baseline[N]);
    }
    console.log();
  }

  // ── Regime version: is ema2 currently on the SAME side as the signal's direction right now,
  // rather than "did a crossover just happen" (tested above, thin and weak -- a crossover is rare
  // and the market stays in whichever regime it lands in for a long time afterward). ──
  console.log("=== Regime alignment (is Cipher A's EMA state currently on the signal's side?) ===");
  const regime = computeEmaRegime(candles);
  const aligned = baseEvents.filter((e) => regime[e.confirmedBarIdx] === e.side);
  const against = baseEvents.filter((e) => regime[e.confirmedBarIdx] != null && regime[e.confirmedBarIdx] !== e.side);
  console.log(`aligned n=${aligned.length}, against n=${against.length}`);
  for (const N of FORWARD_BARS) {
    console.log(`  N=${N}:`);
    report("against (opposite EMA regime)", forwardReturns(against)[N], baseline[N]);
    report("aligned (same-side EMA regime)", forwardReturns(aligned)[N], baseline[N]);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

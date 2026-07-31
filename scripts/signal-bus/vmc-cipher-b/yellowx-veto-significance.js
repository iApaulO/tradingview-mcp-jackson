#!/usr/bin/env node
// Phase 4 of the video-driven plan: does a same-bar Cipher A `yellowCross` veto a Cipher B
// buySignal/sellSignal the way the video claims ("if you see a yellow X on the same candle as a
// green dot, the yellow X takes precedent... stay out or short")? Tests on 5-minute (Phase 1's one
// real, replicated base signal). yellowCross is exclusively a bearish/warning condition in Cipher
// A's own source (no bullish equivalent) -- checked against BOTH buySignal and sellSignal, since
// the video frames it as a general "something's wrong, stay out" flag, not side-specific.
//
// yellowCross is rare by construction (782 events across all of 5m history, vs. 45,192 buySignal/
// sellSignal events) -- exact same-bar overlap is checked first; if too thin to test, a small
// window (+/- a few bars) is reported alongside it, with sample sizes stated plainly either way.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/yellowx-veto-significance.js

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeWtCrossSignals } from "./calc.js";
import { computeYellowCross } from "../vmc-cipher-a/calc.js";

const FORWARD_BARS = [5, 10, 20, 40];
const TF = "5m";
const WINDOWS = [0, 3, 10]; // bars: exact same-bar, then widened windows

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
  const { events: yxEvents } = computeYellowCross(candles);
  console.log(`${TF}: ${baseEvents.length} buySignal/sellSignal events, ${yxEvents.length} yellowCross events\n`);

  const yxBarIdx = new Set(yxEvents.map((e) => e.barIdx));
  const yxSorted = yxEvents.map((e) => e.barIdx).sort((a, b) => a - b);
  function nearYellowX(barIdx, window) {
    if (window === 0) return yxBarIdx.has(barIdx);
    // small linear scan is fine -- yxSorted has only hundreds of entries
    for (const yx of yxSorted) if (Math.abs(yx - barIdx) <= window) return true;
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
    const flagged = baseEvents.filter((e) => nearYellowX(e.confirmedBarIdx, window));
    const clean = baseEvents.filter((e) => !nearYellowX(e.confirmedBarIdx, window));
    console.log(`window=+/-${window} bars: flagged n=${flagged.length}, clean n=${clean.length}`);
    for (const N of FORWARD_BARS) {
      console.log(`  N=${N}:`);
      report("clean (no yellowX)", forwardReturns(clean)[N], baseline[N]);
      report("flagged (yellowX nearby)", forwardReturns(flagged)[N], baseline[N]);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

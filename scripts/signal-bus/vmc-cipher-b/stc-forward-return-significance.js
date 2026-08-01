#!/usr/bin/env node
// Significance test for the Schaff Trend Cycle threshold-cross signal (computeStcCrossSignals,
// calc.js) -- the indicator found live-active during the 2026-08-01 systematic re-inventory
// (ARCHITECTURE.md §33) but never tested. Since the Pine source defines no boolean condition for
// STC at all (see calc.js's header note), this tests the standard stochastic-style operationalization
// (bullish on crossing up through 25, bearish on crossing down through 75) directly against the
// same forward-return methodology used for every other signal in this project: signed return over
// N bars from the confirmation bar, vs. a randomly-sampled-bar-and-side baseline on the same
// timeframe (not a naive 50%, since this data's secular uptrend would bias that).
//
// Tests all 8 signal-bus timeframes (stratified, not just pooled) from the start -- §18.4's lesson
// (pooling can dilute or hide a timeframe-concentrated effect) applies to every new signal in this
// project now, not just divergence.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/stc-forward-return-significance.js

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeStcCrossSignals } from "./calc.js";

const FORWARD_BARS = [5, 10, 20, 40];
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
  const rng = mulberry32(42);
  const maxN = Math.max(...FORWARD_BARS);

  for (const tf of LADDER) {
    const candles = await loadCandles(tf);
    if (candles.length === 0) continue;
    const n = candles.length;
    const { events } = computeStcCrossSignals(candles);
    console.log(`\n=== ${tf}: ${events.length} STC threshold-cross events (${events.filter((e) => e.side === "bullish").length} bullish, ${events.filter((e) => e.side === "bearish").length} bearish) ===`);

    const baseline = {}; for (const N of FORWARD_BARS) baseline[N] = [];
    for (let s = 0; s < events.length; s++) {
      const i = Math.floor(rng() * (n - maxN - 1));
      const side = rng() < 0.5 ? "bearish" : "bullish";
      for (const N of FORWARD_BARS) {
        if (i + N >= n) continue;
        const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
        baseline[N].push(side === "bearish" ? -raw : raw);
      }
    }

    for (const N of FORWARD_BARS) {
      const ev = [];
      for (const e of events) {
        const i = e.confirmedBarIdx;
        if (i + N >= n) continue;
        const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
        ev.push(e.side === "bearish" ? -raw : raw);
      }
      if (ev.length < 30) { console.log(`  N=${N}: n=${ev.length} (too thin to test)`); continue; }
      const evMean = mean(ev), baseMean = mean(baseline[N]);
      const se = Math.sqrt(stderr(ev) ** 2 + stderr(baseline[N]) ** 2);
      const z = (evMean - baseMean) / se;
      const p = 2 * (1 - normalCdf(Math.abs(z)));
      console.log(`  N=${String(N).padEnd(3)} n=${String(ev.length).padEnd(7)} mean=${(evMean * 100).toFixed(3)}%  correct-dir=${(pctCorrect(ev) * 100).toFixed(1)}%  z=${z.toFixed(2)}  p=${p.toFixed(4)} ${p < 0.05 ? "(significant)" : ""}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

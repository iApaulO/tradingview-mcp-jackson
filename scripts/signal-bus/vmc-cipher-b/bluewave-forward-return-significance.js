#!/usr/bin/env node
// Phase 5 (final) of the video-driven plan: standalone forward-return test for "Blue Wave" -- the
// video's own top-billed technique, formalized in calc.js's computeBlueWave() as a shrinking-swing
// pattern in wtVwap (wt1-wt2) triggered on the zero-cross, disclosed as an interpretation of a
// visual pattern rather than a literal Pine port. Same methodology as every other phase: signed
// return over N bars from the signal bar, vs. a same-timeframe randomly-sampled-bar-and-side
// baseline, pooled and stratified.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/bluewave-forward-return-significance.js

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBlueWave } from "./calc.js";

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
  const pooled = {}; for (const N of FORWARD_BARS) pooled[N] = [];
  const pooledBaseline = {}; for (const N of FORWARD_BARS) pooledBaseline[N] = [];
  const byTf = {};

  for (const tf of LADDER) {
    const candles = await loadCandles(tf);
    if (candles.length === 0) continue;
    const n = candles.length;
    const { events } = computeBlueWave(candles);

    byTf[tf] = {}; for (const N of FORWARD_BARS) byTf[tf][N] = [];
    const baselineHere = {}; for (const N of FORWARD_BARS) baselineHere[N] = [];

    for (const e of events) {
      const i = e.confirmedBarIdx;
      for (const N of FORWARD_BARS) {
        if (i + N >= n) continue;
        const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
        const signed = e.side === "bearish" ? -raw : raw;
        byTf[tf][N].push(signed);
        pooled[N].push(signed);
      }
    }

    const maxN = Math.max(...FORWARD_BARS);
    for (let s = 0; s < events.length; s++) {
      const i = Math.floor(rng() * (n - maxN - 1));
      const side = rng() < 0.5 ? "bearish" : "bullish";
      for (const N of FORWARD_BARS) {
        const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
        const signed = side === "bearish" ? -raw : raw;
        baselineHere[N].push(signed);
        pooledBaseline[N].push(signed);
      }
    }
    byTf[tf].baseline = baselineHere;
    byTf[tf].eventCount = events.length;
  }

  function report(label, arr, baselineArr) {
    if (arr.length < 30) { console.log(`  ${label}: n=${arr.length} (too thin to test)`); return; }
    const evMean = mean(arr), baseMean = mean(baselineArr);
    const se = Math.sqrt(stderr(arr) ** 2 + stderr(baselineArr) ** 2);
    const z = (evMean - baseMean) / se;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    console.log(`  ${label.padEnd(6)} n=${String(arr.length).padEnd(7)} mean=${(evMean * 100).toFixed(3)}%  correct-dir=${(pctCorrect(arr) * 100).toFixed(1)}%  z=${z.toFixed(2)}  p=${p.toFixed(4)} ${p < 0.05 ? "(significant)" : ""}`);
  }

  console.log("=== POOLED (all 8 timeframes) ===");
  for (const N of FORWARD_BARS) report(`N=${N}`, pooled[N], pooledBaseline[N]);

  console.log("\n=== STRATIFIED by timeframe ===");
  for (const tf of LADDER) {
    if (!byTf[tf]) continue;
    console.log(`  ${tf} (n events=${byTf[tf].eventCount}):`);
    for (const N of FORWARD_BARS) report(`  N=${N}`, byTf[tf][N], byTf[tf].baseline[N]);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

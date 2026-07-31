#!/usr/bin/env node
// Phase 7 of the video-driven plan (iapaulo, 2026-07-31): "learn the significance of green dots
// occuring above 80 and below -80" -- does a buySignal/sellSignal firing at a MORE EXTREME wt2
// reading (beyond the +/-53 OB/OS gate that defines the signal at all) predict a stronger forward
// move, the way #38's confirm-count buckets showed a clean dose-response? Tested the same way:
// bucket by wt2 magnitude at the signal bar, forward-return each bucket against the same
// randomly-sampled baseline used throughout this project, and look for monotonicity across buckets
// rather than trusting any single cell.
//
// Buckets chosen to bracket the video's specific claim (80/-80) inside the existing OB/OS gate
// (53/-53): [53,60) [60,70) [70,80) [80,+inf). wt2 is look-ahead-safe by construction here -- it's
// read at the exact signal bar, the same bar forward returns are measured from, no different than
// any other same-bar attribute already used elsewhere in this project (e.g. #37's same-bar MFI).
//
// Usage: node scripts/signal-bus/vmc-cipher-b/wt2-extremity-significance.js

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeWtCrossSignals, computeWaveTrend } from "./calc.js";

const FORWARD_BARS = [5, 10, 20, 40];
const TF = "5m";
const BUCKETS = [
  { label: "53-60", min: 53, max: 60 },
  { label: "60-70", min: 60, max: 70 },
  { label: "70-80", min: 70, max: 80 },
  { label: "80-90", min: 80, max: 90 },
  { label: "90-100", min: 90, max: 100 },
  { label: "100+", min: 100, max: Infinity },
];

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
  const { wt2 } = computeWaveTrend(candles);
  console.log(`${TF}: ${baseEvents.length} Cipher B buySignal/sellSignal events\n`);

  // |wt2| at the signal bar -- buySignal fires with wt2 <= -53 (bullish), sellSignal with wt2 >= 53
  // (bearish); "extremity" is the magnitude past the gate regardless of side.
  const withExtremity = baseEvents.map((e) => ({ ...e, extremity: Math.abs(wt2[e.confirmedBarIdx]) }));

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
    console.log(`    ${label.padEnd(10)} n=${String(arr.length).padEnd(6)} mean=${(evMean * 100).toFixed(3)}%  correct-dir=${(pctCorrect(arr) * 100).toFixed(1)}%  z=${z.toFixed(2)}  p=${p.toFixed(4)} ${p < 0.05 ? "(significant)" : ""}`);
  }

  console.log("=== Dose-response by wt2 extremity at signal bar ===");
  for (const N of FORWARD_BARS) {
    console.log(`  N=${N}:`);
    for (const b of BUCKETS) {
      const bucketEvents = withExtremity.filter((e) => e.extremity >= b.min && e.extremity < b.max);
      report(b.label, forwardReturns(bucketEvents)[N], baseline[N]);
    }
  }

  console.log("\n=== Bucket sizes (all extremities, informational) ===");
  for (const b of BUCKETS) {
    const c = withExtremity.filter((e) => e.extremity >= b.min && e.extremity < b.max).length;
    console.log(`  ${b.label}: n=${c}`);
  }

  // A direct correlation view, complementary to the discrete buckets above -- does raw extremity
  // magnitude correlate with forward return sign/size at all, pooled across all events?
  console.log("\n=== Pearson correlation: wt2 extremity vs. forward return (side-adjusted) ===");
  for (const N of FORWARD_BARS) {
    const xs = [], ys = [];
    for (const e of withExtremity) {
      const i = e.confirmedBarIdx;
      if (i + N >= n) continue;
      const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
      xs.push(e.extremity);
      ys.push(e.side === "bearish" ? -raw : raw);
    }
    const mx = mean(xs), my = mean(ys);
    let cov = 0, vx = 0, vy = 0;
    for (let k = 0; k < xs.length; k++) {
      cov += (xs[k] - mx) * (ys[k] - my);
      vx += (xs[k] - mx) ** 2;
      vy += (ys[k] - my) ** 2;
    }
    const r = cov / Math.sqrt(vx * vy);
    console.log(`  N=${N}: r=${r.toFixed(4)}  (n=${xs.length})`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

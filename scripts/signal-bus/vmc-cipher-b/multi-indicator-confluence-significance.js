#!/usr/bin/env node
// Phase 8 of the video-driven plan (iapaulo, 2026-07-31): "also learn the significance of...
// multi indicator confluence of signals occuring in these ranges" -- within Cipher B's own
// extreme-wt2 ranges characterized by Phase 7 (§27), does agreement from a GENUINELY INDEPENDENT
// signal compound the edge?
//
// PART 1 (checked, then abandoned as degenerate): Cipher A's own wt2 reading extreme on the same
// side at the same bar as Cipher B's. Caught before trusting it -- Cipher A wt2 and Cipher B wt2
// correlate at r=0.9993 across 939,150 bars (near-identical WaveTrend formula, wtAverageLen 12 vs
// 13 is the only real difference), so "confluence" here is close to measuring the same number
// twice, not independent agreement. Reported below for the record, then Part 2 uses a genuinely
// distinct detection method instead.
//
// PART 2 (the real test): Cipher B's own regular WT divergence (`computeVmcCipherB`, a fractal-
// pivot detector, structurally unrelated to the OB/OS-threshold-crossing detector behind
// buySignal/sellSignal, though both read the same wt2 series) -- does a same-side divergence zone
// confirmed at-or-before a buySignal/sellSignal, within a short window, compound the wt2-extremity
// effect from §27? Past-only window, same look-ahead-safe convention used throughout this project
// (§22/§26's corrected nearYellowX/nearGreenDot).
//
// Usage: node scripts/signal-bus/vmc-cipher-b/multi-indicator-confluence-significance.js

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeWtCrossSignals, computeWaveTrend as computeWaveTrendB, computeVmcCipherB } from "./calc.js";
import { computeWaveTrend as computeWaveTrendA } from "../vmc-cipher-a/calc.js";

const FORWARD_BARS = [5, 10, 20, 40];
const TF = "5m";
const CIPHER_A_GATE = 53; // reusing Cipher B's own OB/OS gate against Cipher A's wt2, Part 1 only
const DIV_WINDOW = 10; // bars, past-only -- matches §22/§26's corrected window scale

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
  const { wt2: wt2B } = computeWaveTrendB(candles);
  console.log(`${TF}: ${baseEvents.length} Cipher B buySignal/sellSignal events\n`);

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
    console.log(`    ${label.padEnd(28)} n=${String(arr.length).padEnd(6)} mean=${(evMean * 100).toFixed(3)}%  correct-dir=${(pctCorrect(arr) * 100).toFixed(1)}%  z=${z.toFixed(2)}  p=${p.toFixed(4)} ${p < 0.05 ? "(significant)" : ""}`);
  }

  // ── Part 1: Cipher A wt2 confluence, kept for the record, flagged as degenerate ──
  console.log("=== Part 1: Cipher A wt2 also beyond +/-53 same side (checked, then flagged as near-degenerate) ===");
  const { wt2: wt2A } = computeWaveTrendA(candles);
  {
    const xs = [], ys = [];
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(wt2A[i]) || Number.isNaN(wt2B[i])) continue;
      xs.push(wt2A[i]); ys.push(wt2B[i]);
    }
    const mx = mean(xs), my = mean(ys);
    let cov = 0, vx = 0, vy = 0;
    for (let k = 0; k < xs.length; k++) { cov += (xs[k] - mx) * (ys[k] - my); vx += (xs[k] - mx) ** 2; vy += (ys[k] - my) ** 2; }
    console.log(`  Cipher A wt2 vs Cipher B wt2 correlation: r=${(cov / Math.sqrt(vx * vy)).toFixed(4)} (n=${xs.length}) -- near 1.0 means this is not independent confirmation`);
  }
  const withA = baseEvents.map((e) => {
    const aVal = wt2A[e.confirmedBarIdx];
    const confluent = e.side === "bullish" ? aVal <= -CIPHER_A_GATE : aVal >= CIPHER_A_GATE;
    return { ...e, confluentA: Number.isNaN(aVal) ? null : confluent };
  }).filter((e) => e.confluentA !== null);
  const notConfluentA = withA.filter((e) => !e.confluentA);
  console.log(`  not-confluent n=${notConfluentA.length} (thin because of the near-1.0 correlation above -- not read as a real effect)\n`);

  // ── Part 2: Cipher B's own regular WT divergence as a genuinely distinct confirming signal ──
  console.log("=== Part 2: same-side Cipher B regular WT divergence within the last " + DIV_WINDOW + " bars (genuinely distinct detector) ===");
  const { zones } = computeVmcCipherB(candles);
  const regularZones = zones.filter((z) => z.kind === "regular");
  const divBySide = {
    bullish: regularZones.filter((z) => z.side === "bullish").map((z) => z.confirmedBarIdx).sort((a, b) => a - b),
    bearish: regularZones.filter((z) => z.side === "bearish").map((z) => z.confirmedBarIdx).sort((a, b) => a - b),
  };
  function nearDivergence(side, barIdx, window) {
    for (const b of divBySide[side]) {
      if (b > barIdx) break; // future divergence -- does not count, no look-ahead (same fix as §22/§26)
      if (barIdx - b <= window) return true;
    }
    return false;
  }
  const withD = baseEvents.map((e) => ({ ...e, extremityB: Math.abs(wt2B[e.confirmedBarIdx]), divConfluent: nearDivergence(e.side, e.confirmedBarIdx, DIV_WINDOW) }));
  const divConfluent = withD.filter((e) => e.divConfluent);
  const divNot = withD.filter((e) => !e.divConfluent);
  console.log(`div-confluent n=${divConfluent.length}, not n=${divNot.length}\n`);
  for (const N of FORWARD_BARS) {
    console.log(`  N=${N}:`);
    report("no recent divergence", forwardReturns(divNot)[N], baseline[N]);
    report("recent same-side divergence", forwardReturns(divConfluent)[N], baseline[N]);
  }

  console.log("\n=== Part 2 interaction with §27's wt2-extremity buckets ===");
  const BUCKETS = [
    { label: "53-70 (below peak)", min: 53, max: 70 },
    { label: "70-80 (§27 peak)", min: 70, max: 80 },
    { label: "80-100 (decaying)", min: 80, max: 100 },
    { label: "100+ (§27 reversal)", min: 100, max: Infinity },
  ];
  for (const b of BUCKETS) {
    const inBucket = withD.filter((e) => e.extremityB >= b.min && e.extremityB < b.max);
    const bConfluent = inBucket.filter((e) => e.divConfluent);
    const bNot = inBucket.filter((e) => !e.divConfluent);
    console.log(`\n  bucket ${b.label}: div-confluent n=${bConfluent.length}, not n=${bNot.length}`);
    for (const N of FORWARD_BARS) {
      console.log(`    N=${N}:`);
      report("not confluent", forwardReturns(bNot)[N], baseline[N]);
      report("confluent", forwardReturns(bConfluent)[N], baseline[N]);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

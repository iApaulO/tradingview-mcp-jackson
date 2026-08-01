#!/usr/bin/env node
// iapaulo's hypothesis (2026-08-01), directly after STC's standalone falsification (§34): "instead
// of using it as a buy/sell im thinking that other signals such as divergence or others also
// happening during stc extremes would have a predictive edge... aligned with your current findings
// that stc should not be used as standalone." Exactly the pattern already proven twice in this
// project (§27's WT2-extremity dose-response, §28's multi-indicator confluence in extreme ranges) --
// applied here with STC as the extremity variable instead of Cipher B's own WT2.
//
// Checked BEFORE building this (not assumed): STC correlates with Cipher B's own wt2 at r=0.69 --
// meaningfully independent, nowhere near the r=0.9993 near-duplicate that sank §28 Part 1 (Cipher A
// wt2 vs Cipher B wt2). A genuinely different construction (MACD-based double-stochastic vs.
// ATR-normalized channel deviation) that happens to share real information, not a second copy of
// the same number.
//
// "Same-direction STC extremity" defined symmetrically for any bullish/bearish event, read at the
// event's own bar (a continuous STATE, not a recent-event check -- no look-ahead risk, same
// discipline as §20/§26's same-bar MFI/regime reads):
//   bullish event: extremity = 100 - stc   (stc near 0/oversold -> extremity near 100)
//   bearish event: extremity = stc         (stc near 100/overbought -> extremity near 100)
// Bucketed 0-25 (STC against) / 25-50 (STC neutral-against) / 50-75 (STC neutral-aligned) /
// 75-100 (STC strongly aligned, the "STC extreme in the signal's own favor" reading iapaulo proposed).
//
// Tests three already-established signals against this: Cipher B buySignal/sellSignal (5m, the
// flagship signal, §19), Cipher B regular divergence (5m, §17/§18), and Cipher B regular divergence
// (daily, §31/#49 -- the SECOND FINDING IN THIS PROJECT TO CLEAR REAL COSTS, highest value if this
// compounds it).
//
// Usage: node scripts/signal-bus/vmc-cipher-b/stc-extremity-confluence-significance.js

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeStc, computeWtCrossSignals, computeVmcCipherB } from "./calc.js";

const FORWARD_BARS = [5, 10, 20, 40];

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

const BUCKETS = [
  { label: "0-25 (STC against)", min: 0, max: 25 },
  { label: "25-50 (neutral-against)", min: 25, max: 50 },
  { label: "50-75 (neutral-aligned)", min: 50, max: 75 },
  { label: "75-100 (STC extreme, aligned)", min: 75, max: 100.01 },
];

async function testSignal(label, tf, getEvents) {
  const candles = await loadCandles(tf);
  const n = candles.length;
  const stc = computeStc(candles);
  const events = getEvents(candles).filter((e) => Number.isFinite(stc[e.confirmedBarIdx]));
  console.log(`\n################ ${label} (${tf}, n=${events.length}) ################`);
  if (events.length < 30) { console.log("  too thin to test"); return; }

  const withExtremity = events.map((e) => {
    const s = stc[e.confirmedBarIdx];
    const extremity = e.side === "bullish" ? 100 - s : s;
    return { ...e, extremity };
  });

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
  for (let s = 0; s < events.length; s++) {
    const i = Math.floor(rng() * (n - maxN - 1));
    const side = rng() < 0.5 ? "bearish" : "bullish";
    for (const N of FORWARD_BARS) {
      const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
      baseline[N].push(side === "bearish" ? -raw : raw);
    }
  }

  function report(name, arr, baselineArr) {
    if (arr.length < 30) { console.log(`    ${name}: n=${arr.length} (too thin)`); return; }
    const evMean = mean(arr), baseMean = mean(baselineArr);
    const se = Math.sqrt(stderr(arr) ** 2 + stderr(baselineArr) ** 2);
    const z = (evMean - baseMean) / se;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    console.log(`    ${name.padEnd(30)} n=${String(arr.length).padEnd(6)} mean=${(evMean * 100).toFixed(3)}%  correct-dir=${(pctCorrect(arr) * 100).toFixed(1)}%  z=${z.toFixed(2)}  p=${p.toFixed(4)} ${p < 0.05 ? "(significant)" : ""}`);
  }

  console.log("  -- overall (raw, replicate of the already-established baseline) --");
  for (const N of FORWARD_BARS) {
    console.log(`  N=${N}:`);
    report("all", forwardReturns(withExtremity)[N], baseline[N]);
  }

  console.log("\n  -- dose-response by same-direction STC extremity --");
  for (const N of FORWARD_BARS) {
    console.log(`  N=${N}:`);
    for (const b of BUCKETS) {
      const inBucket = withExtremity.filter((e) => e.extremity >= b.min && e.extremity < b.max);
      report(b.label, forwardReturns(inBucket)[N], baseline[N]);
    }
  }
  console.log("\n  bucket sizes:", BUCKETS.map((b) => `${b.label}: n=${withExtremity.filter((e) => e.extremity >= b.min && e.extremity < b.max).length}`).join(", "));
}

async function main() {
  await testSignal("Cipher B buySignal/sellSignal", "5m", (candles) => computeWtCrossSignals(candles).events);
  await testSignal("Cipher B regular divergence", "5m", (candles) => computeVmcCipherB(candles).zones.filter((z) => z.kind === "regular"));
  await testSignal("Cipher B regular divergence", "1d", (candles) => computeVmcCipherB(candles).zones.filter((z) => z.kind === "regular"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

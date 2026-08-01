#!/usr/bin/env node
// Direct follow-up to iapaulo's request ("let's test a coarser timeframe for divergence
// significance"). §18.4/#35 already stratified regular divergence by timeframe and found nothing
// individually significant above 5-minute -- rerun fresh here (unchanged: 1d/4h/2h/15m null, 3h/1h
// single non-replicating hits, only 5m replicates across horizons). But that per-timeframe test is
// likely UNDERPOWERED on its own, not necessarily evidence of a true null: over this project's
// 8.95-year data span, regular divergence only fires 224 times on 4h and 44 times on 1d, vs. 9,766
// on 5m -- at n=224, the minimum detectable effect (95% power-free back-of-envelope, Bernoulli
// variance) is roughly 9 points, well above the 4-5 point edge actually seen on 5m. A real,
// identically-sized effect on 4h could easily fail to clear significance individually just from
// sample size, not because it isn't there.
//
// This pools 15m/1h/2h/3h/4h/1d (excludes 5m, already separately established; excludes 1w, only 4
// events total, too thin to contribute) into one combined sample and tests it against a pooled
// baseline (same random-bar-and-side convention, drawn proportionally per timeframe) -- a
// well-powered test of "does Cipher B regular divergence show a real directional edge somewhere
// coarser than 5m," even if no single rung of the ladder can carry that claim alone.
//
// Motivation for bothering, not just curiosity: the fixed round-trip fee is a MUCH smaller fraction
// of the typical stop distance on coarser timeframes (checked directly: fee is 88.6% of 0.6xATR(14)
// risk on 5m, but only 24.3% on 1h and 11.9% on 4h) -- so if a real edge survives here, it has a
// genuinely better shot at clearing costs than anything found on 5m so far.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/coarser-tf-pooled-significance.js

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeRegularDivergenceUnion } from "./calc.js";

const POOLED_LADDER = ["15m", "1h", "2h", "3h", "4h", "1d"]; // coarser than 5m, excludes 1w (too thin)
const FORWARD_BARS = [5, 10, 20, 40]; // each timeframe's OWN bar count -- same convention as every other forward-return test in this project

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

  // REBUILT 2026-08-01 after finding the "2nd WT Regular Divergence" gap (iapaulo caught a real
  // undercount vs. the live chart) -- computeRegularDivergenceUnion() now returns the TRUE on-chart
  // divergence-dot population (regular OR regular_add, deduped), not just the stricter "regular"
  // gate this script used before. See ARCHITECTURE.md §31 and calc.js's header note.
  console.log("=== Per-timeframe event counts (regular+regular_add union divergence, this pooled set) ===");
  const perTf = {};
  for (const tf of POOLED_LADDER) {
    const candles = await loadCandles(tf);
    const { zones: regularZones } = computeRegularDivergenceUnion(candles);
    perTf[tf] = { candles, zones: regularZones };
    console.log(`  ${tf}: ${regularZones.length} events`);
  }

  // Pooled event returns + pooled baseline (same random-bar-and-side convention per timeframe,
  // proportional to each timeframe's own event count -- matches every other test in this project).
  const pooledEventReturns = {}; for (const N of FORWARD_BARS) pooledEventReturns[N] = [];
  const pooledBaselineReturns = {}; for (const N of FORWARD_BARS) pooledBaselineReturns[N] = [];
  const perTfEventReturns = {}; // for the per-timeframe breakdown table

  for (const tf of POOLED_LADDER) {
    const { candles, zones } = perTf[tf];
    const n = candles.length;
    const evRet = {}; for (const N of FORWARD_BARS) evRet[N] = [];
    for (const z of zones) {
      const i = z.confirmedBarIdx;
      if (i < 0 || i >= n) continue;
      for (const N of FORWARD_BARS) {
        if (i + N >= n) continue;
        const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
        evRet[N].push(z.side === "bearish" ? -raw : raw);
      }
    }
    perTfEventReturns[tf] = evRet;
    for (const N of FORWARD_BARS) pooledEventReturns[N].push(...evRet[N]);

    for (let s = 0; s < zones.length; s++) {
      const i = Math.floor(rng() * (n - maxN - 1));
      const side = rng() < 0.5 ? "bearish" : "bullish";
      for (const N of FORWARD_BARS) {
        const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
        pooledBaselineReturns[N].push(side === "bearish" ? -raw : raw);
      }
    }
  }

  function report(label, arr, baselineArr) {
    if (arr.length < 30) { console.log(`    ${label}: n=${arr.length} (too thin)`); return; }
    const evMean = mean(arr), baseMean = mean(baselineArr);
    const se = Math.sqrt(stderr(arr) ** 2 + stderr(baselineArr) ** 2);
    const z = (evMean - baseMean) / se;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    console.log(`    ${label.padEnd(28)} n=${String(arr.length).padEnd(7)} mean=${(evMean * 100).toFixed(3)}%  correct-dir=${(pctCorrect(arr) * 100).toFixed(1)}%  z=${z.toFixed(2)}  p=${p.toFixed(4)} ${p < 0.05 ? "(significant)" : ""}`);
  }

  console.log(`\n=== POOLED (${POOLED_LADDER.join("+")}) regular divergence vs. pooled random-bar-and-side baseline ===`);
  for (const N of FORWARD_BARS) {
    console.log(`  N=${N} bars (each timeframe's own bar count):`);
    report("pooled coarser-TF divergence", pooledEventReturns[N], pooledBaselineReturns[N]);
  }

  console.log("\n=== For reference: per-timeframe breakdown of the SAME pooled events (not independently baselined here -- see timeframe-stratified-significance.js for that) ===");
  for (const tf of POOLED_LADDER) {
    console.log(`  ${tf}:`);
    for (const N of FORWARD_BARS) {
      const arr = perTfEventReturns[tf][N];
      if (arr.length < 10) { console.log(`    N=${N}: n=${arr.length} (thin)`); continue; }
      console.log(`    N=${N}: n=${arr.length}  correct-dir=${(pctCorrect(arr) * 100).toFixed(1)}%  mean=${(mean(arr) * 100).toFixed(3)}%`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

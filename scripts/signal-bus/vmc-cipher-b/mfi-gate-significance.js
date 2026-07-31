#!/usr/bin/env node
// Phase 2 of the video-driven plan: does the MFI "environment" gate (video's rule: green/positive
// MFI -> only take longs on dips, i.e. only trust buySignal when mfi>0; red/negative MFI -> only
// take shorts, only trust sellSignal when mfi<0) improve on Phase 1's raw buySignal/sellSignal
// baseline? Same non-overlapping-window forward-return methodology, same z-test-vs-baseline
// comparison used throughout today. Same-timeframe MFI value at the signal bar (the simplest,
// most direct reading of the rule) -- reported both pooled and stratified since Phase 1 already
// showed pooling can hide a timeframe-concentrated effect.
//
// NOTE on a real, disclosed limitation found while sanity-checking this build: on 4h, buySignal
// (oversold cross-up) co-occurs with mfi<=0 far more often (334 vs 99) than mfi>0, and sellSignal
// the mirror image (415 vs 117 mfi>0) -- the OPPOSITE base rate from the video's simple heuristic.
// This makes sense on reflection: same-bar MFI captures recent momentum, which is often already
// negative right before an oversold bounce triggers (and positive right before an overbought top
// triggers) -- MFI as the video actually describes it is a slower-moving, higher-timeframe REGIME
// concept ("start with the larger time frames to identify environment"), not a same-bar co-reading.
// This same-timeframe version is the simplest, most literal test of the stated rule; if it doesn't
// help, the natural next step (folds into Phase 3) is a higher-timeframe MFI regime instead.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/mfi-gate-significance.js

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeWtCrossSignals } from "./calc.js";

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
  // Two buckets: 'aligned' (buySignal & mfi>0, or sellSignal & mfi<0 -- the video's rule) and
  // 'against' (the opposite reading) -- comparing both against Phase 1's raw (ungated) baseline
  // makes it possible to see whether the gate HELPS (aligned beats raw) or just reflects the base
  // rate skew noted above.
  const byTf = {};

  for (const tf of LADDER) {
    const candles = await loadCandles(tf);
    if (candles.length === 0) continue;
    const n = candles.length;
    const { events } = computeWtCrossSignals(candles);
    const validEvents = events.filter((e) => !Number.isNaN(e.mfi));

    const aligned = validEvents.filter((e) => (e.signal === "buySignal" && e.mfi > 0) || (e.signal === "sellSignal" && e.mfi < 0));
    const against = validEvents.filter((e) => (e.signal === "buySignal" && e.mfi <= 0) || (e.signal === "sellSignal" && e.mfi >= 0));

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
    const alignedReturns = forwardReturns(aligned);
    const againstReturns = forwardReturns(against);
    const allReturns = forwardReturns(validEvents); // raw, ungated -- this run's own Phase-1-equivalent baseline

    const baseline = {}; for (const N of FORWARD_BARS) baseline[N] = [];
    const maxN = Math.max(...FORWARD_BARS);
    for (let s = 0; s < validEvents.length; s++) {
      const i = Math.floor(rng() * (n - maxN - 1));
      const side = rng() < 0.5 ? "bearish" : "bullish";
      for (const N of FORWARD_BARS) {
        const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
        baseline[N].push(side === "bearish" ? -raw : raw);
      }
    }

    byTf[tf] = { alignedCount: aligned.length, againstCount: against.length, rawCount: validEvents.length, alignedReturns, againstReturns, allReturns, baseline };
  }

  function report(label, arr, baselineArr) {
    if (arr.length < 30) { console.log(`    ${label}: n=${arr.length} (too thin)`); return; }
    const evMean = mean(arr), baseMean = mean(baselineArr);
    const se = Math.sqrt(stderr(arr) ** 2 + stderr(baselineArr) ** 2);
    const z = (evMean - baseMean) / se;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    console.log(`    ${label.padEnd(20)} n=${String(arr.length).padEnd(7)} mean=${(evMean * 100).toFixed(3)}%  correct-dir=${(pctCorrect(arr) * 100).toFixed(1)}%  z=${z.toFixed(2)}  p=${p.toFixed(4)} ${p < 0.05 ? "(significant)" : ""}`);
  }

  for (const tf of LADDER) {
    if (!byTf[tf]) continue;
    const d = byTf[tf];
    console.log(`${tf}: raw n=${d.rawCount}, MFI-aligned n=${d.alignedCount}, MFI-against n=${d.againstCount}`);
    for (const N of FORWARD_BARS) {
      console.log(`  N=${N}:`);
      report("raw (ungated)", d.allReturns[N], d.baseline[N]);
      report("MFI-aligned (video rule)", d.alignedReturns[N], d.baseline[N]);
      report("MFI-against", d.againstReturns[N], d.baseline[N]);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

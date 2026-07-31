#!/usr/bin/env node
// Phase 3 of the video-driven plan: does a buySignal/sellSignal on 5-minute (Phase 1's one real,
// replicated signal) confirmed by a SAME-SIDE dot on a HIGHER timeframe, within a recent window,
// outperform one with no such confirmation? Different question from §18.4's per-timeframe
// stratification (which asked "which single timeframe alone is best") -- this asks whether
// cross-timeframe AGREEMENT adds value on top of the best single timeframe already found.
//
// Window definition: for a higher timeframe with bar duration D, "recent" = within the last
// LOOKBACK_BARS (3) bars of THAT timeframe as of the 5m event's time -- scales naturally (a 3-hour
// lookback on 1h, a 3-day lookback on 1d, a 3-week lookback on 1w), avoiding the flat-window
// mistake iapaulo already caught once today (the original Divergence-for-Many x Cipher B
// confluence check used "ever in 9 years," which turned out to be nearly meaningless).
//
// Implemented as a two-pointer sweep per higher timeframe (both event lists are chronologically
// sorted) rather than a per-event linear scan across all higher-TF events -- correctness-preserving,
// just efficient at 45k+ base events.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/multi-tf-stacking-significance.js

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeWtCrossSignals } from "./calc.js";

const FORWARD_BARS = [5, 10, 20, 40];
const BASE_TF = "5m";
const HIGHER_LADDER = ["15m", "1h", "2h", "3h", "4h", "1d", "1w"]; // ascending, all coarser than 5m
const TF_SECONDS = { "5m": 300, "15m": 900, "1h": 3600, "2h": 7200, "3h": 10800, "4h": 14400, "1d": 86400, "1w": 604800 };
const LOOKBACK_BARS = 3;

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
  const baseCandles = await loadCandles(BASE_TF);
  const n = baseCandles.length;
  const { events: baseEvents } = computeWtCrossSignals(baseCandles);
  console.log(`${BASE_TF} base events: ${baseEvents.length}`);

  // Load higher-TF events, sorted by time (already chronological from calc.js).
  const higherEvents = {};
  for (const tf of HIGHER_LADDER) {
    const candles = await loadCandles(tf);
    if (candles.length === 0) continue;
    const { events } = computeWtCrossSignals(candles);
    higherEvents[tf] = events;
    console.log(`  ${tf}: ${events.length} events (lookback window ${LOOKBACK_BARS * TF_SECONDS[tf] / 3600}h)`);
  }

  // Two-pointer: for each higher TF, track a window [start, end) of event indices whose
  // confirmedTime falls within [currentTime - lookback, currentTime], advancing as base events
  // move forward in time (base events are chronological).
  const pointers = {}; for (const tf of HIGHER_LADDER) pointers[tf] = { lo: 0, hi: 0 };

  const confirmCount = []; // per base event, how many higher TFs confirmed
  for (const e of baseEvents) {
    const t = e.confirmedTime;
    let count = 0;
    for (const tf of HIGHER_LADDER) {
      const list = higherEvents[tf];
      if (!list) continue;
      const windowSec = LOOKBACK_BARS * TF_SECONDS[tf];
      const p = pointers[tf];
      while (p.hi < list.length && list[p.hi].confirmedTime <= t) p.hi++;
      while (p.lo < p.hi && list[p.lo].confirmedTime < t - windowSec) p.lo++;
      let matched = false;
      for (let k = p.lo; k < p.hi; k++) { if (list[k].side === e.side) { matched = true; break; } }
      if (matched) count++;
    }
    confirmCount.push(count);
  }

  const rng = mulberry32(42);
  const maxN = Math.max(...FORWARD_BARS);
  function forwardReturns(indices) {
    const out = {}; for (const N of FORWARD_BARS) out[N] = [];
    for (const idx of indices) {
      const e = baseEvents[idx];
      const i = e.confirmedBarIdx;
      for (const N of FORWARD_BARS) {
        if (i + N >= n) continue;
        const raw = (baseCandles[i + N].c - baseCandles[i].c) / baseCandles[i].c;
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
      const raw = (baseCandles[i + N].c - baseCandles[i].c) / baseCandles[i].c;
      baseline[N].push(side === "bearish" ? -raw : raw);
    }
  }

  const noConfirmIdx = [], anyConfirmIdx = [];
  const byCountIdx = {}; // 0,1,2,3+
  for (let i = 0; i < baseEvents.length; i++) {
    const c = confirmCount[i];
    if (c === 0) noConfirmIdx.push(i); else anyConfirmIdx.push(i);
    const bucket = c >= 3 ? "3+" : String(c);
    if (!byCountIdx[bucket]) byCountIdx[bucket] = [];
    byCountIdx[bucket].push(i);
  }

  function report(label, arr, baselineArr) {
    if (arr.length < 30) { console.log(`    ${label}: n=${arr.length} (too thin)`); return; }
    const evMean = mean(arr), baseMean = mean(baselineArr);
    const se = Math.sqrt(stderr(arr) ** 2 + stderr(baselineArr) ** 2);
    const z = (evMean - baseMean) / se;
    const p = 2 * (1 - normalCdf(Math.abs(z)));
    console.log(`    ${label.padEnd(24)} n=${String(arr.length).padEnd(7)} mean=${(evMean * 100).toFixed(3)}%  correct-dir=${(pctCorrect(arr) * 100).toFixed(1)}%  z=${z.toFixed(2)}  p=${p.toFixed(4)} ${p < 0.05 ? "(significant)" : ""}`);
  }

  console.log(`\nconfirm-count distribution: ${Object.entries(byCountIdx).map(([k, v]) => `${k}=${v.length}`).join(", ")}\n`);

  for (const N of FORWARD_BARS) {
    console.log(`N=${N}:`);
    report("raw (all, Phase 1 replicate)", forwardReturns(baseEvents.map((_, i) => i))[N], baseline[N]);
    report("no higher-TF confirmation", forwardReturns(noConfirmIdx)[N], baseline[N]);
    report("any higher-TF confirmation", forwardReturns(anyConfirmIdx)[N], baseline[N]);
    for (const bucket of ["0", "1", "2", "3+"]) {
      if (!byCountIdx[bucket]) continue;
      report(`  confirm-count=${bucket}`, forwardReturns(byCountIdx[bucket])[N], baseline[N]);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

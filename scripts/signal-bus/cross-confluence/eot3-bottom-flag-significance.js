#!/usr/bin/env node
// iapaulo's hypothesis, mechanically stated after live-verifying an exact instance (2026-08-09):
// "the yellow line crossed down to bottom on 17nov [2025] and returned to top 22dec... i am not
// saying this is [a] buy signal but since it doesn't come with a long flag it should logically be
// the exit value for the current divergence." "the yellow line" = EOT3's Quotient5 (q5,
// boom-hunter/calc.js, ported 2026-08-09 specifically for this question -- previously left
// unported on the assumption it only feeds the Exit Warning circles). Verified against the live
// example first: q5 crosses down through 50 on the exact date given (2025-11-17) and back up on
// the exact date given (2025-12-22), on weekly -- confirms the port before testing anything on it.
//
// "Bottom" = q5 crossing DOWN through 50 (its own square-wave-like midpoint -- confirmed q5/q6
// saturate near -10/+110 and transition abruptly, matching iapaulo's own description "q5 never
// stops anywhere at the bottom"). "Accompanied by a flag" -- CORRECTED per iapaulo's direct
// pushback on the first version ("we are not necessarily looking for flags nearby we would be
// confirming the flag's appearance or absence during the time yellow line it is down"): a fixed
// +/-N-bar WINDOW around the crossing bar is the wrong shape entirely. The real question is whether
// ANY of the four Long-tier plotshapes (lime/blue/yellow/gray -- "yellow" here means the ACTUAL
// enter7 flag, not q5; the two "yellow" concepts are genuinely different things in this indicator,
// confirmed from source; enter4 included too, already validated #60a) fires ANYWHERE during the
// WHOLE episode q5 spends below 50 -- from the crossunder bar through to the next crossover bar
// (or through to the end of available data if q5 hasn't recovered yet, in which case the episode is
// marked ongoing and excluded from the classification, since its full flag history isn't settled).
//
// Test: does a NO-flag bottom crossing behave differently going forward than a WITH-flag one --
// specifically, does price show more of a stabilize/reverse-up pattern after a no-flag crossing
// (the "exit value for the current divergence" reading) than after a with-flag one? Forward-return
// methodology (correct-direction/mean-return over N-bar horizons), matching this project's
// established convention for signals with no natural price-anchored stop/target (Cipher B's
// buysell-forward-return-significance.js pattern), not the OB+fixed-R construction -- there is no
// order block or stop level naturally attached to a raw oscillator crossing. Per iapaulo's
// explicit request, run across the full ladder, not just weekly.
//
// Episodes are now read from `boom-hunter.db`'s `eot3_episodes` table (persisted 2026-08-09 by
// build-historical.js/calc.js) instead of recomputed here from raw candles -- closes the gap where
// q5/q6 were the one indicator output in the whole bus not written to storage. Numbers match this
// file's own original from-scratch computation exactly (verified against the pre-persistence run).
//
// Usage: node scripts/signal-bus/cross-confluence/eot3-bottom-flag-significance.js [--iterations=20000] [--horizons=5,10,20,40]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const BOOM_DB_PATH = new URL("../../../data/signal-bus/boom-hunter.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const HORIZONS = (args.horizons || "5,10,20,40").split(",").map(Number);

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function mean(v) { return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }

// Forward log-return from the crossing bar's close, N bars later (clamped to series end).
function forwardReturn(candles, barIdx, horizon) {
  const endIdx = Math.min(candles.length - 1, barIdx + horizon);
  if (endIdx <= barIdx) return null;
  return candles[endIdx].c / candles[barIdx].c - 1;
}

function permutationTestMeans(groupALabels, values, iterations, seed) {
  const n = values.length;
  const realA = mean(values.filter((_, i) => groupALabels[i]));
  const realB = mean(values.filter((_, i) => !groupALabels[i]));
  if (realA == null || realB == null) return null;
  const realGap = realA - realB;
  const rng = mulberry32(seed);
  const permGaps = [];
  for (let i = 0; i < iterations; i++) {
    const shuffled = shuffle(groupALabels, rng);
    const a = [], b = [];
    for (let j = 0; j < n; j++) (shuffled[j] ? a : b).push(values[j]);
    if (a.length === 0 || b.length === 0) continue;
    permGaps.push(mean(a) - mean(b));
  }
  permGaps.sort((x, y) => x - y);
  const p = permGaps.filter((g) => g >= realGap).length / permGaps.length;
  return { realA, realB, realGap, p, nA: values.filter((_, i) => groupALabels[i]).length, nB: values.filter((_, i) => !groupALabels[i]).length };
}
function fmtPct(x) { return x != null ? (x * 100).toFixed(2) + "%" : "n/a"; }
function fmtGap(t) { return t ? `gap=${(t.realGap * 100).toFixed(2)}pts p=${t.p.toFixed(4)}${t.p < 0.05 ? "*" : ""}` : "n/a"; }

async function runTimeframe(tf) {
  const candles = await loadCandles(tf);

  const boomDb = new DatabaseSync(BOOM_DB_PATH, { readOnly: true });
  const rows = boomDb.prepare("SELECT start_bar_idx, end_bar_idx, start_time, has_flag FROM eot3_episodes WHERE timeframe = ?").all(tf);
  boomDb.close();
  const crossings = rows.map((r) => ({ barIdx: r.start_bar_idx, endIdx: r.end_bar_idx, time: r.start_time, hasFlag: !!r.has_flag }));

  const results = {};
  for (const h of HORIZONS) {
    const withReturns = [], withoutReturns = [];
    const labels = [], values = [];
    for (const c of crossings) {
      const r = forwardReturn(candles, c.barIdx, h);
      if (r == null) continue;
      (c.hasFlag ? withReturns : withoutReturns).push(r);
      labels.push(c.hasFlag);
      values.push(r);
    }
    const test = permutationTestMeans(labels, values, ITERATIONS, SEED + h);
    const upFracWith = withReturns.length ? withReturns.filter((r) => r > 0).length / withReturns.length : null;
    const upFracWithout = withoutReturns.length ? withoutReturns.filter((r) => r > 0).length / withoutReturns.length : null;
    results[h] = { withN: withReturns.length, withoutN: withoutReturns.length, withMean: mean(withReturns), withoutMean: mean(withoutReturns), upFracWith, upFracWithout, test };
  }
  return { tf, candles, crossings, crossingCount: crossings.length, withFlagCount: crossings.filter((c) => c.hasFlag).length, results };
}

async function main() {
  console.log(`EOT3 (q5, "the yellow line") bottom-crossing (crosses down through 50) test, with vs without a Long-tier flag firing ANYWHERE during the whole episode q5 spends below 50 (not a fixed-bar window around the crossing -- corrected per iapaulo's direct pushback on the first version). Forward returns at ${HORIZONS.join("/")} bars.\n`);

  const allResults = {};
  for (const tf of LADDER_KEYS) {
    const r = await runTimeframe(tf);
    allResults[tf] = r;
    console.log(`=== ${tf} === ${r.crossingCount} resolved q5 down-episodes (${r.withFlagCount} with a flag during, ${r.crossingCount - r.withFlagCount} without)`);
    for (const h of HORIZONS) {
      const res = r.results[h];
      console.log(
        `  N=${h}: with-flag n=${res.withN} meanRet=${fmtPct(res.withMean)} upFrac=${fmtPct(res.upFracWith)}` +
        `  |  no-flag n=${res.withoutN} meanRet=${fmtPct(res.withoutMean)} upFrac=${fmtPct(res.upFracWithout)}` +
        `  |  ${fmtGap(res.test)}`,
      );
    }
    console.log();
  }

  // Pooled across all timeframes (each crossing weighted equally regardless of source timeframe) --
  // reuses the candles/crossings already computed above, no redundant recomputation.
  console.log(`=== POOLED (all timeframes) ===`);
  for (const h of HORIZONS) {
    const labels = [], values = [];
    for (const tf of LADDER_KEYS) {
      const { candles, crossings } = allResults[tf];
      for (const c of crossings) {
        const r = forwardReturn(candles, c.barIdx, h);
        if (r == null) continue;
        labels.push(c.hasFlag); values.push(r);
      }
    }
    const test = permutationTestMeans(labels, values, ITERATIONS, SEED + 1000 + h);
    const withVals = values.filter((_, i) => labels[i]), withoutVals = values.filter((_, i) => !labels[i]);
    console.log(
      `  N=${h}: with-flag n=${withVals.length} meanRet=${fmtPct(mean(withVals))} upFrac=${fmtPct(withVals.filter((r) => r > 0).length / withVals.length)}` +
      `  |  no-flag n=${withoutVals.length} meanRet=${fmtPct(mean(withoutVals))} upFrac=${fmtPct(withoutVals.filter((r) => r > 0).length / withoutVals.length)}` +
      `  |  ${fmtGap(test)}`,
    );
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  // Strip candles/crossings (large, and candles are trivially reproducible from load-candles.js) --
  // keep only the summary stats.
  const summaryResults = {};
  for (const tf of LADDER_KEYS) {
    const { candles, crossings, ...rest } = allResults[tf];
    summaryResults[tf] = rest;
  }
  const payload = { allResults: summaryResults, horizons: HORIZONS, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `eot3_bottom_flag_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

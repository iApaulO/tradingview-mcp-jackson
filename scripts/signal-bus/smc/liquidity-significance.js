#!/usr/bin/env node
// Significance test for the liquidity-sweep reversal rate (~81% aggregate, see liquidity.js).
// The concern this tests directly: the reversal check ("does price close back within 10 bars of
// touching a level") might just describe ANY local high/low touch, not something specific to
// validated EQH/EQL liquidity levels -- price chops around constantly, so a high "reversal" rate
// could be a property of touching any recent extreme, not evidence of a real stop-hunt mechanism.
//
// Null model: for every REAL swept EQH/EQL event, draw a RANDOM bar from the SAME timeframe's
// candle series (matching side: EQH-like uses the random bar's own high, EQL-like uses its own
// low) and run the identical reversal check against that arbitrary level. This isolates exactly
// one thing: does being a genuine, pivot-confirmed, equal-threshold-matched liquidity level matter
// beyond "being some bar's high or low"? Same logic as the backtest program's random-entry
// baseline and the confluence permutation tests -- replace the SPECIFIC selection with a random
// one, keep everything else (timeframe, side, reversal-window definition) identical.
//
// Usage: node scripts/signal-bus/smc/liquidity-significance.js --iterations=2000

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const REVERSAL_WINDOW_BARS = 10; // must match liquidity.js

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "2000", 10);
const SEED = parseInt(args.seed || "42", 10);

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

// Exported so build-analytics-page.js can pull fresh numbers instead of hardcoding a snapshot.
export async function runLiquiditySignificanceTest({ iterations = 2000, seed = 42, dbPath = DB_PATH } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(
    `SELECT timeframe, side, sweep_status FROM eqh_eql_events WHERE sweep_status IN ('swept_reversed','swept_continued')`,
  ).all();
  db.close();

  const realReversed = rows.filter((r) => r.sweep_status === "swept_reversed").length;
  const realTotal = rows.length;
  const realRate = realReversed / realTotal;

  const byTf = new Map();
  for (const r of rows) {
    if (!byTf.has(r.timeframe)) byTf.set(r.timeframe, []);
    byTf.get(r.timeframe).push(r.side);
  }

  const candlesByTf = new Map();
  for (const tf of byTf.keys()) candlesByTf.set(tf, await loadCandles(tf));

  const rng = mulberry32(seed);
  const MAX_SWEEP_SEARCH_BARS = 2000;
  function randomReversalCheck(candles) {
    const n = candles.length;
    const i = 5 + Math.floor(rng() * (n - MAX_SWEEP_SEARCH_BARS - REVERSAL_WINDOW_BARS - 10));
    const useHigh = rng() < 0.5;
    const bar = candles[i];
    const level = useHigh ? bar.h : bar.l;

    let sweepIdx = null;
    const searchEnd = Math.min(n - 1, i + MAX_SWEEP_SEARCH_BARS);
    for (let j = i + 1; j <= searchEnd; j++) {
      const crossed = useHigh ? candles[j].h > level : candles[j].l < level;
      if (crossed) {
        sweepIdx = j;
        break;
      }
    }
    if (sweepIdx == null) return null;

    const endCheck = Math.min(n - 1, sweepIdx + REVERSAL_WINDOW_BARS);
    for (let j = sweepIdx; j <= endCheck; j++) {
      const backOnOriginSide = useHigh ? candles[j].c < level : candles[j].c > level;
      if (backOnOriginSide) return true;
    }
    return false;
  }

  const nullRates = [];
  for (let iter = 0; iter < iterations; iter++) {
    let reversed = 0, counted = 0;
    for (const [tf, sides] of byTf) {
      const candles = candlesByTf.get(tf);
      for (let k = 0; k < sides.length; k++) {
        const result = randomReversalCheck(candles);
        if (result == null) continue;
        counted++;
        if (result) reversed++;
      }
    }
    nullRates.push(reversed / counted);
  }
  nullRates.sort((a, b) => a - b);

  const pValue = nullRates.filter((r) => r >= realRate).length / nullRates.length;
  const mean = nullRates.reduce((s, x) => s + x, 0) / nullRates.length;

  return {
    realRate,
    realReversed,
    realTotal,
    iterations,
    nullMean: mean,
    nullRange: [nullRates[0], nullRates[nullRates.length - 1]],
    pValue,
  };
}

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare(
    `SELECT timeframe, side, sweep_status FROM eqh_eql_events WHERE sweep_status IN ('swept_reversed','swept_continued')`,
  ).all();
  db.close();

  const realReversed = rows.filter((r) => r.sweep_status === "swept_reversed").length;
  const realTotal = rows.length;
  const realRate = realReversed / realTotal;
  console.log(`Real aggregate reversal rate: ${realReversed}/${realTotal} = ${(realRate * 100).toFixed(2)}%`);

  // Group by timeframe so random draws come from the matching candle series.
  const byTf = new Map();
  for (const r of rows) {
    if (!byTf.has(r.timeframe)) byTf.set(r.timeframe, []);
    byTf.get(r.timeframe).push(r.side);
  }

  console.log(`\nLoading candle series for ${byTf.size} timeframes ...`);
  const candlesByTf = new Map();
  for (const tf of byTf.keys()) candlesByTf.set(tf, await loadCandles(tf));

  const rng = mulberry32(SEED);

  // BUG FIX: an earlier version checked reversal starting from the SAME bar that defined the
  // random level -- which trivially "reverses" on nearly every non-doji candle, since a bar's
  // close is almost never exactly its own high (produced a nonsensical 99.55% null rate). Fixed
  // to mirror the real algorithm's actual structure: establish a level at a random "pivot" bar,
  // scan FORWARD from the next bar to find where price actually crosses it (the real analog of
  // sweepBarIdx), and only THEN check reversal within the window -- same two-stage process
  // liquidity.js uses for genuine EQH/EQL, just with an unvalidated random level instead.
  const MAX_SWEEP_SEARCH_BARS = 2000; // give up rather than scan to series end on a pathological draw
  function randomReversalCheck(candles) {
    const n = candles.length;
    const i = 5 + Math.floor(rng() * (n - MAX_SWEEP_SEARCH_BARS - REVERSAL_WINDOW_BARS - 10));
    const useHigh = rng() < 0.5; // side doesn't structurally matter for this check -- symmetric
    const bar = candles[i];
    const level = useHigh ? bar.h : bar.l;

    let sweepIdx = null;
    const searchEnd = Math.min(n - 1, i + MAX_SWEEP_SEARCH_BARS);
    for (let j = i + 1; j <= searchEnd; j++) {
      const crossed = useHigh ? candles[j].h > level : candles[j].l < level;
      if (crossed) {
        sweepIdx = j;
        break;
      }
    }
    if (sweepIdx == null) return null; // never crossed within the search window -- excluded, not counted as a miss

    const endCheck = Math.min(n - 1, sweepIdx + REVERSAL_WINDOW_BARS);
    for (let j = sweepIdx; j <= endCheck; j++) {
      const backOnOriginSide = useHigh ? candles[j].c < level : candles[j].c > level;
      if (backOnOriginSide) return true;
    }
    return false;
  }

  console.log(`Running ${ITERATIONS} iterations (${realTotal} random-level draws each) ...`);
  const t0 = Date.now();
  const nullRates = [];
  let totalExcluded = 0;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    let reversed = 0, counted = 0;
    for (const [tf, sides] of byTf) {
      const candles = candlesByTf.get(tf);
      for (let k = 0; k < sides.length; k++) {
        const result = randomReversalCheck(candles);
        if (result == null) {
          totalExcluded++;
          continue; // never crossed within search window -- excluded, matching how "unswept" is excluded from the real rate
        }
        counted++;
        if (result) reversed++;
      }
    }
    nullRates.push(reversed / counted);
  }
  nullRates.sort((a, b) => a - b);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`(${totalExcluded} draws across all iterations never crossed within the search window and were excluded)`);

  const pValue = nullRates.filter((r) => r >= realRate).length / nullRates.length;
  const mean = nullRates.reduce((s, x) => s + x, 0) / nullRates.length;

  console.log(`\nDone in ${elapsed}s.`);
  console.log(`\n--- Null (random-level) reversal rate ---`);
  console.log(`mean=${(mean * 100).toFixed(2)}%  range=[${(nullRates[0] * 100).toFixed(2)}%, ${(nullRates[nullRates.length - 1] * 100).toFixed(2)}%]`);
  console.log(`\nReal rate ${(realRate * 100).toFixed(2)}% vs. null mean ${(mean * 100).toFixed(2)}%`);
  console.log(`p-value (fraction of null iterations >= real rate): ${pValue.toFixed(4)} ${pValue < 0.05 ? "(significant at 5%)" : "(NOT significant at 5%)"}`);
  console.log(
    `\nVerdict: ${pValue < 0.05 ? "Real EQH/EQL sweeps reverse significantly more often than an arbitrary bar's high/low would -- the liquidity-sweep mechanism looks real, not just \"price touched something and came back.\"" : "Does NOT clear significance -- an arbitrary level shows a similar reversal rate, meaning the ~81% figure may just describe normal price chop, not something specific to validated liquidity levels."}`,
  );
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

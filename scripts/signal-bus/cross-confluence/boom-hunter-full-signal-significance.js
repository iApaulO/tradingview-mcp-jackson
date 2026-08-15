#!/usr/bin/env node
// The "full read" iapaulo asked for: every Boom Hunter signal (not just the 4 visible Longs) tested
// against real order block outcomes, both sides. Two things long-ob-continuation-significance.js
// didn't cover:
//   1. SHORT side -- Break/senter3 paired with bearish order blocks, mirroring the validated Long
//      methodology exactly (price-anchored, real touches, fixed-R). Uses bearish_continuation as the
//      confirming signal -- flagged throughout as NOT from source (see calc.js header), a mirror
//      constructed for this test, not something veryfid's indicator actually shows.
//   2. Dead code -- boom_dead (enter2/"Boom!", plotshape commented out), long_dead_enter4 (enter4,
//      never wired to anything), long_dead_enter (enter, LSMA-gated, never wired). Tested the same
//      way as the 4 visible Long tiers, same price-anchored pairing with bullish OBs, to see whether
//      any of it would outperform (or be redundant with) what's already visible in the live indicator.
//
// Same real order_block_touches + fixed-R methodology as every SMC/confluence test tonight.
//
// Usage: node scripts/signal-bus/cross-confluence/boom-hunter-full-signal-significance.js [--iterations=20000] [--r=1,1.5] [--pre-window=50] [--post-window=50] [--price-tolerance=0.01]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const BOOM_DB_PATH = new URL("../../../data/signal-bus/boom-hunter.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const MAX_HOLD_BARS = 200;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULTIPLES = (args.r || "1,1.5").split(",").map(Number);
const PRE_WINDOW = parseInt(args["pre-window"] || "50", 10);
const POST_WINDOW = parseInt(args["post-window"] || "50", 10);
const PRICE_TOLERANCE_PCT = parseFloat(args["price-tolerance"] || "0.01");

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
function winRate(vals) { return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null; }
function groupStats(obs, predicate) {
  const wins = [];
  for (const o of obs) if (predicate(o)) wins.push(...o.wins);
  return { n: wins.length, winRate: winRate(wins) };
}
function permutationTest(obsSubset, iterations, seed, predicateA) {
  const realA = groupStats(obsSubset, predicateA).winRate;
  const realB = groupStats(obsSubset, (o) => !predicateA(o)).winRate;
  if (realA == null || realB == null) return null;
  const realGap = realA - realB;
  const labels = obsSubset.map(predicateA);
  const rng = mulberry32(seed);
  const permGaps = [];
  for (let i = 0; i < iterations; i++) {
    const shuffled = shuffle(labels, rng);
    let winsX = 0, nX = 0, winsY = 0, nY = 0;
    for (let j = 0; j < obsSubset.length; j++) {
      const w = obsSubset[j].wins;
      if (shuffled[j]) { winsX += w.reduce((s, x) => s + x, 0); nX += w.length; }
      else { winsY += w.reduce((s, x) => s + x, 0); nY += w.length; }
    }
    if (nX === 0 || nY === 0) continue;
    permGaps.push(winsX / nX - winsY / nY);
  }
  permGaps.sort((a, b) => a - b);
  const p = permGaps.filter((g) => g >= realGap).length / permGaps.length;
  return { realA, realB, realGap, p };
}

// side='bullish'|'bearish'. entrySignalTypes = boom-hunter event types that mark the level.
// confirmType = boom-hunter event type that confirms afterward (or null to skip that stage).
function classifyOBs(smcDb, boomDb, timeframe, side, entrySignalTypes, confirmType, preWindow, priceTolerancePct, postWindow) {
  const obs = smcDb.prepare(
    "SELECT id, origin_bar_idx, origin_time, bar_high, bar_low FROM order_blocks WHERE timeframe = ? AND side = ?",
  ).all(timeframe, side);
  const placeholders = entrySignalTypes.map(() => "?").join(",");
  const signals = boomDb.prepare(
    `SELECT type, bar_idx, price FROM events WHERE timeframe = ? AND type IN (${placeholders})`,
  ).all(timeframe, ...entrySignalTypes);
  const confirmations = confirmType
    ? boomDb.prepare("SELECT bar_idx FROM events WHERE timeframe = ? AND type = ?").all(timeframe, confirmType).map((r) => r.bar_idx)
    : [];

  const classification = new Map();
  for (const ob of obs) {
    const precedingSignals = signals.filter((l) => {
      if (l.bar_idx > ob.origin_bar_idx || ob.origin_bar_idx - l.bar_idx > preWindow) return false;
      const tol = l.price * priceTolerancePct;
      return ob.bar_low - tol <= l.price && l.price <= ob.bar_high + tol;
    });
    const hasSignalBefore = precedingSignals.length > 0;
    const hasConfirmAfter = confirmType ? confirmations.some((c) => c >= ob.origin_bar_idx && c - ob.origin_bar_idx <= postWindow) : true;

    let group;
    if (hasSignalBefore && hasConfirmAfter) group = "full";
    else if (hasSignalBefore || (confirmType && hasConfirmAfter)) group = "partial";
    else group = "neither";

    classification.set(ob.id, { group, signalTypes: precedingSignals.map((s) => s.type) });
  }
  return classification;
}

async function buildOutcomes(rMultiple, side, candlesByTf, classificationByTf) {
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const obRows = smcDb.prepare("SELECT id, timeframe, side, bar_high, bar_low FROM order_blocks WHERE side = ?").all(side);
  const touchRows = smcDb.prepare("SELECT order_block_id, start_bar_idx FROM order_block_touches").all();
  smcDb.close();

  const obById = new Map(obRows.map((o) => [o.id, o]));
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    if (!ob) continue;
    if (!entriesByTf.has(ob.timeframe)) entriesByTf.set(ob.timeframe, []);
    entriesByTf.get(ob.timeframe).push({ startBarIdx: t.start_bar_idx, ob });
  }

  const obOutcomes = new Map();
  for (const [tf, entries] of entriesByTf) {
    const candles = candlesByTf[tf];
    const classification = classificationByTf[tf];
    for (const e of entries) {
      const entryIdx = e.startBarIdx + 1;
      if (entryIdx >= candles.length) continue;
      const entryPrice = candles[entryIdx].o;
      const stopPrice = side === "bullish" ? e.ob.bar_low : e.ob.bar_high;
      const risk = side === "bullish" ? entryPrice - stopPrice : stopPrice - entryPrice;
      if (risk <= 0) continue;
      const targetPrice = side === "bullish" ? entryPrice + rMultiple * risk : entryPrice - rMultiple * risk;
      let outcome = null;
      const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
      for (let j = entryIdx; j <= endCheck; j++) {
        const bar = candles[j];
        const hitStop = side === "bullish" ? bar.l <= stopPrice : bar.h >= stopPrice;
        const hitTarget = side === "bullish" ? bar.h >= targetPrice : bar.l <= targetPrice;
        if (hitStop) { outcome = 0; break; }
        if (hitTarget) { outcome = 1; break; }
      }
      if (outcome == null) continue;
      const c = classification.get(e.ob.id) || { group: "neither" };
      if (!obOutcomes.has(e.ob.id)) obOutcomes.set(e.ob.id, { group: c.group, timeframe: tf, wins: [] });
      obOutcomes.get(e.ob.id).wins.push(outcome);
    }
  }
  return [...obOutcomes.values()];
}

async function runScenario(label, side, entrySignalTypes, confirmType, rMultiple, candlesByTf, iterations, seed) {
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const boomDb = new DatabaseSync(BOOM_DB_PATH, { readOnly: true });
  const classificationByTf = {};
  for (const tf of LADDER_KEYS) {
    classificationByTf[tf] = classifyOBs(smcDb, boomDb, tf, side, entrySignalTypes, confirmType, PRE_WINDOW, PRICE_TOLERANCE_PCT, POST_WINDOW);
  }
  smcDb.close(); boomDb.close();

  const obs = await buildOutcomes(rMultiple, side, candlesByTf, classificationByTf);
  const totalTrades = obs.reduce((s, o) => s + o.wins.length, 0);
  const counts = { full: 0, partial: 0, neither: 0 };
  for (const o of obs) counts[o.group]++;

  const fullStats = groupStats(obs, (o) => o.group === "full");
  const neitherStats = groupStats(obs, (o) => o.group === "neither");
  const partialStats = groupStats(obs, (o) => o.group === "partial");
  const vsNeither = permutationTest(obs.filter((o) => o.group !== "partial"), iterations, seed, (o) => o.group === "full");
  const vsPartial = permutationTest(obs.filter((o) => o.group !== "neither"), iterations, seed + 1, (o) => o.group === "full");

  console.log(`\n=== ${label} (${rMultiple}R) [POOLED, all 8 timeframes] ===`);
  console.log(`  ${obs.length} ${side} order blocks (full=${counts.full}, partial=${counts.partial}, neither=${counts.neither}), ${totalTrades} trades`);
  console.log(`  full: n=${fullStats.n} winRate=${fullStats.winRate != null ? (fullStats.winRate * 100).toFixed(1) + "%" : "n/a"}   partial: n=${partialStats.n} winRate=${partialStats.winRate != null ? (partialStats.winRate * 100).toFixed(1) + "%" : "n/a"}   neither: n=${neitherStats.n} winRate=${neitherStats.winRate != null ? (neitherStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  if (vsNeither) console.log(`  full vs neither: gap=${(vsNeither.realGap * 100).toFixed(1)}pts p=${vsNeither.p.toFixed(4)}${vsNeither.p < 0.05 ? "*" : ""}`);
  if (vsPartial) console.log(`  full vs partial: gap=${(vsPartial.realGap * 100).toFixed(1)}pts p=${vsPartial.p.toFixed(4)}${vsPartial.p < 0.05 ? "*" : ""}`);

  // Per-timeframe breakdown -- a pooled significant result can hide the fact that no single
  // timeframe individually clears the bar (confirmed real for Boom!/enter2: pooled cleared p<0.05
  // in all 4 slots, but split by timeframe only 2 of 4 individual TF/R cells did, still always
  // directionally positive). Reported unconditionally now, not as a one-off diagnostic.
  console.log(`  --- per timeframe ---`);
  const byTf = {};
  for (const tf of LADDER_KEYS) {
    const tfObs = obs.filter((o) => o.timeframe === tf);
    if (tfObs.length === 0) continue;
    const tfFull = groupStats(tfObs, (o) => o.group === "full");
    const tfPartial = groupStats(tfObs, (o) => o.group === "partial");
    const tfNeither = groupStats(tfObs, (o) => o.group === "neither");
    const tfVsNeither = permutationTest(tfObs.filter((o) => o.group !== "partial"), iterations, seed + 1000, (o) => o.group === "full");
    const tfVsPartial = permutationTest(tfObs.filter((o) => o.group !== "neither"), iterations, seed + 1001, (o) => o.group === "full");
    byTf[tf] = { full: tfFull, partial: tfPartial, neither: tfNeither, vsNeither: tfVsNeither, vsPartial: tfVsPartial };
    const sN = tfVsNeither && tfVsNeither.p < 0.05 ? "*" : "";
    const sP = tfVsPartial && tfVsPartial.p < 0.05 ? "*" : "";
    console.log(
      `    ${tf.padEnd(4)} full n=${String(tfFull.n).padEnd(6)} winRate=${tfFull.winRate != null ? (tfFull.winRate * 100).toFixed(1) + "%" : "n/a "}` +
      `  vsNeither gap=${tfVsNeither ? (tfVsNeither.realGap * 100).toFixed(1) + "pts p=" + tfVsNeither.p.toFixed(4) + sN : "n/a"}` +
      `  vsPartial gap=${tfVsPartial ? (tfVsPartial.realGap * 100).toFixed(1) + "pts p=" + tfVsPartial.p.toFixed(4) + sP : "n/a"}`,
    );
  }

  return { label, side, rMultiple, obCount: obs.length, tradeCount: totalTrades, counts, fullStats, partialStats, neitherStats, vsNeither, vsPartial, byTf };
}

async function main() {
  const candlesByTf = {};
  for (const tf of LADDER_KEYS) candlesByTf[tf] = await loadCandles(tf);

  const results = [];
  for (const r of R_MULTIPLES) {
    console.log(`\n########## ${r}R ##########`);

    console.log("\n--- SHORT SIDE (real Break/senter3 signal, real Break/senter3->bearish OB->bearish_continuation NOT-FROM-SOURCE mirror) ---");
    results.push(await runScenario("short: Break -> bearish OB -> bearish_continuation", "bearish", ["break_short"], "bearish_continuation", r, candlesByTf, ITERATIONS, SEED + 100));
    results.push(await runScenario("short: Break -> bearish OB (no confirm stage)", "bearish", ["break_short"], null, r, candlesByTf, ITERATIONS, SEED + 200));

    console.log("\n--- DEAD CODE, LONG SIDE (bullish OB -> Continuation, same confirm stage as the visible Longs) ---");
    results.push(await runScenario("dead: Boom! (enter2) -> bullish OB -> Continuation", "bullish", ["boom_dead"], "continuation", r, candlesByTf, ITERATIONS, SEED + 300));
    results.push(await runScenario("dead: enter4 -> bullish OB -> Continuation", "bullish", ["long_enter4"], "continuation", r, candlesByTf, ITERATIONS, SEED + 400));
    results.push(await runScenario("dead: enter (LSMA) -> bullish OB -> Continuation", "bullish", ["long_dead_enter"], "continuation", r, candlesByTf, ITERATIONS, SEED + 500));
    results.push(await runScenario("dead: ALL 3 dead signals combined -> bullish OB -> Continuation", "bullish", ["boom_dead", "long_enter4", "long_dead_enter"], "continuation", r, candlesByTf, ITERATIONS, SEED + 600));
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results, preWindow: PRE_WINDOW, postWindow: POST_WINDOW, priceTolerance: PRICE_TOLERANCE_PCT, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `boom_hunter_full_signal_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

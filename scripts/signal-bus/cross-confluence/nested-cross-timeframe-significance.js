#!/usr/bin/env node
// The "nested" test iapaulo asked about: does a Boom Hunter Long signal firing on a SLOWER timeframe
// too, near the same price and roughly the same time as an already-validated full-sequence bullish
// OB (Long -> OB -> Continuation on its own timeframe), make that setup stronger? Mirrors SMC's own
// confluenceCount concept (distinct timeframes agreeing) rather than inventing a new one -- same
// question, applied to Boom Hunter instead of order-block price levels.
//
// For every "full sequence" bullish OB (same classification as long-ob-continuation-significance.js),
// checks every SLOWER timeframe in the ladder for a Long signal (any tier) within NESTED_WINDOW_BARS
// of that SLOWER timeframe's own bars, at a price near the OB's zone. "nested" = at least one slower
// timeframe agrees; "solo" = none do. Real order_block_touches + fixed-R methodology, permutation
// test, per-timeframe breakdown (same discipline as the rest of this suite).
//
// Usage: node scripts/signal-bus/cross-confluence/nested-cross-timeframe-significance.js [--iterations=20000] [--r=1,1.5] [--pre-window=50] [--post-window=50] [--price-tolerance=0.01] [--nested-window=10]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const BOOM_DB_PATH = new URL("../../../data/signal-bus/boom-hunter.db", import.meta.url);
// Ordered SLOWEST to FASTEST -- "slower than timeframe X" = every entry to X's own left in this array.
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const MAX_HOLD_BARS = 200;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULTIPLES = (args.r || "1,1.5").split(",").map(Number);
const PRE_WINDOW = parseInt(args["pre-window"] || "50", 10);
const POST_WINDOW = parseInt(args["post-window"] || "50", 10);
const PRICE_TOLERANCE_PCT = parseFloat(args["price-tolerance"] || "0.01");
const NESTED_WINDOW_BARS = parseInt(args["nested-window"] || "10", 10); // bars of the SLOWER timeframe

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

// Same full-sequence classification as long-ob-continuation-significance.js -- Long (any tier)
// preceding at the OB's price, Continuation following, both on the OB's OWN timeframe.
function classifyFullSequence(smcDb, boomDb, timeframe) {
  const obs = smcDb.prepare(
    "SELECT id, origin_bar_idx, origin_time, bar_high, bar_low FROM order_blocks WHERE timeframe = ? AND side = 'bullish'",
  ).all(timeframe);
  const longs = boomDb.prepare(
    "SELECT bar_idx, price FROM events WHERE timeframe = ? AND type IN ('long_lime','long_blue','long_yellow','long_gray')",
  ).all(timeframe);
  const continuations = boomDb.prepare(
    "SELECT bar_idx FROM events WHERE timeframe = ? AND type = 'continuation'",
  ).all(timeframe).map((r) => r.bar_idx);

  const fullOBs = [];
  for (const ob of obs) {
    const hasLongBefore = longs.some((l) => {
      if (l.bar_idx > ob.origin_bar_idx || ob.origin_bar_idx - l.bar_idx > PRE_WINDOW) return false;
      const tol = l.price * PRICE_TOLERANCE_PCT;
      return ob.bar_low - tol <= l.price && l.price <= ob.bar_high + tol;
    });
    const hasContinuationAfter = continuations.some((c) => c >= ob.origin_bar_idx && c - ob.origin_bar_idx <= POST_WINDOW);
    if (hasLongBefore && hasContinuationAfter) fullOBs.push(ob);
  }
  return fullOBs;
}

// REFINED per iapaulo: the original version checked symmetric proximity (slower-TF signal within N
// bars either direction) -- that's not the mechanism described. The actual claim is sequential: a
// slower timeframe confirms FIRST, establishing context, and the faster timeframe's signal fires
// WITHIN that already-established window afterward. Now requires the slower-TF signal to have
// happened AT OR BEFORE the OB's origin (never after), within a real-time lookback window scaled to
// that slower timeframe's own bar duration. Also now returns the full cascade depth (how many
// slower timeframes agree, not just yes/no), so "1d then 4h then 15m/5m" can be tested as a
// dose-response, not collapsed to a single binary.
function checkNesting(boomDb, ob, ownTimeframe) {
  const ownIdx = LADDER_KEYS.indexOf(ownTimeframe);
  const slowerTfs = LADDER_KEYS.slice(0, ownIdx); // everything to the left = slower
  const nestedOn = [];
  for (const tf of slowerTfs) {
    const windowSec = NESTED_WINDOW_BARS * BAR_DURATION_SEC[tf];
    const longs = boomDb.prepare(
      "SELECT bar_idx, time, price FROM events WHERE timeframe = ? AND type IN ('long_lime','long_blue','long_yellow','long_gray')",
    ).all(tf);
    const match = longs.some((l) => {
      if (l.time > ob.origin_time) return false; // must precede, not just be nearby
      if (ob.origin_time - l.time > windowSec) return false;
      const tol = l.price * PRICE_TOLERANCE_PCT;
      return ob.bar_low - tol <= l.price && l.price <= ob.bar_high + tol;
    });
    if (match) nestedOn.push(tf);
  }
  return nestedOn;
}

async function buildOutcomes(rMultiple, candlesByTf, classificationByTf) {
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const obRows = smcDb.prepare("SELECT id, timeframe, side, bar_high, bar_low FROM order_blocks WHERE side = 'bullish'").all();
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
    const classification = classificationByTf[tf]; // Map ob.id -> { nested: bool, nestedOn: [] }
    for (const e of entries) {
      if (!classification.has(e.ob.id)) continue; // only full-sequence OBs are in scope for this test
      const entryIdx = e.startBarIdx + 1;
      if (entryIdx >= candles.length) continue;
      const entryPrice = candles[entryIdx].o;
      const stopPrice = e.ob.bar_low;
      const risk = entryPrice - stopPrice;
      if (risk <= 0) continue;
      const targetPrice = entryPrice + rMultiple * risk;
      let outcome = null;
      const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
      for (let j = entryIdx; j <= endCheck; j++) {
        const bar = candles[j];
        if (bar.l <= stopPrice) { outcome = 0; break; }
        if (bar.h >= targetPrice) { outcome = 1; break; }
      }
      if (outcome == null) continue;
      const c = classification.get(e.ob.id);
      if (!obOutcomes.has(e.ob.id)) obOutcomes.set(e.ob.id, { nested: c.nested, depth: c.nestedOn.length, timeframe: tf, wins: [] });
      obOutcomes.get(e.ob.id).wins.push(outcome);
    }
  }
  return [...obOutcomes.values()];
}

async function runForRMultiple(rMultiple, candlesByTf, classificationByTf, iterations, seed) {
  console.log(`\n=== ${rMultiple}R ===`);
  const obs = await buildOutcomes(rMultiple, candlesByTf, classificationByTf);
  const totalTrades = obs.reduce((s, o) => s + o.wins.length, 0);
  const nNested = obs.filter((o) => o.nested).length, nSolo = obs.filter((o) => !o.nested).length;
  console.log(`${obs.length} full-sequence bullish order blocks (nested=${nNested}, solo=${nSolo}), ${totalTrades} resolved trades. [nested window=${NESTED_WINDOW_BARS} bars of the slower TF]`);

  const nestedStats = groupStats(obs, (o) => o.nested);
  const soloStats = groupStats(obs, (o) => !o.nested);
  console.log(`  nested (>=1 slower TF also has a Long signal at this level): n=${nestedStats.n}, winRate=${nestedStats.winRate != null ? (nestedStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  console.log(`  solo (no slower-TF agreement):                                n=${soloStats.n}, winRate=${soloStats.winRate != null ? (soloStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);

  const test = permutationTest(obs, iterations, seed, (o) => o.nested);
  if (test) console.log(`  nested vs solo: gap=${(test.realGap * 100).toFixed(1)}pts p=${test.p.toFixed(4)}${test.p < 0.05 ? "*" : ""}`);

  // Dose-response by cascade DEPTH -- iapaulo's actual claim is "1d then 4h then 15m/5m", i.e. more
  // levels agreeing in sequence should be progressively stronger, not just "any vs none."
  console.log(`\n  --- by cascade depth (how many slower timeframes agree, in sequence) ---`);
  const maxDepth = Math.max(...obs.map((o) => o.depth), 0);
  const depthStats = [];
  for (let d = 0; d <= maxDepth; d++) {
    const s = groupStats(obs, (o) => o.depth === d);
    depthStats.push({ depth: d, ...s });
    console.log(`    depth=${d}: n=${s.n}, winRate=${s.winRate != null ? (s.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  }
  let depthTrend = null;
  if (maxDepth >= 2) {
    depthTrend = permutationTest(obs.filter((o) => o.depth === 0 || o.depth >= 2), iterations, seed + 500, (o) => o.depth >= 2);
    if (depthTrend) console.log(`  depth>=2 vs depth=0: gap=${(depthTrend.realGap * 100).toFixed(1)}pts p=${depthTrend.p.toFixed(4)}${depthTrend.p < 0.05 ? "*" : ""}`);
  }

  console.log(`\n  --- per timeframe (only 4h and faster can have a slower TF to nest against) ---`);
  const byTf = {};
  for (const tf of LADDER_KEYS) {
    const tfObs = obs.filter((o) => o.timeframe === tf);
    if (tfObs.length === 0) continue;
    const tfNested = groupStats(tfObs, (o) => o.nested);
    const tfSolo = groupStats(tfObs, (o) => !o.nested);
    const tfTest = permutationTest(tfObs, iterations, seed + 1000, (o) => o.nested);
    byTf[tf] = { nested: tfNested, solo: tfSolo, test: tfTest };
    const s = tfTest && tfTest.p < 0.05 ? "*" : "";
    console.log(
      `    ${tf.padEnd(4)} nested n=${String(tfNested.n).padEnd(6)} winRate=${tfNested.winRate != null ? (tfNested.winRate * 100).toFixed(1) + "%" : "n/a "}` +
      `  solo n=${String(tfSolo.n).padEnd(6)} winRate=${tfSolo.winRate != null ? (tfSolo.winRate * 100).toFixed(1) + "%" : "n/a "}` +
      `  gap=${tfTest ? (tfTest.realGap * 100).toFixed(1) + "pts p=" + tfTest.p.toFixed(4) + s : "n/a"}`,
    );
  }

  return { rMultiple, obCount: obs.length, tradeCount: totalTrades, nNested, nSolo, nestedStats, soloStats, test, depthStats, depthTrend, byTf };
}

export async function runNestedCrossTimeframeTest({
  iterations = ITERATIONS, seed = SEED, rMultiples = R_MULTIPLES, nestedWindowBars = NESTED_WINDOW_BARS,
} = {}) {
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const boomDb = new DatabaseSync(BOOM_DB_PATH, { readOnly: true });
  const candlesByTf = {};
  const classificationByTf = {};
  for (const tf of LADDER_KEYS) {
    candlesByTf[tf] = await loadCandles(tf);
    const fullOBs = classifyFullSequence(smcDb, boomDb, tf);
    const m = new Map();
    for (const ob of fullOBs) {
      const nestedOn = checkNesting(boomDb, ob, tf);
      m.set(ob.id, { nested: nestedOn.length > 0, nestedOn });
    }
    classificationByTf[tf] = m;
  }
  smcDb.close(); boomDb.close();

  const results = {};
  for (const r of rMultiples) results[`${r}R`] = await runForRMultiple(r, candlesByTf, classificationByTf, iterations, seed);
  return { results, preWindow: PRE_WINDOW, postWindow: POST_WINDOW, priceTolerance: PRICE_TOLERANCE_PCT, nestedWindowBars };
}

async function main() {
  const out = await runNestedCrossTimeframeTest({});
  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { ...out, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `nested_cross_timeframe_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}

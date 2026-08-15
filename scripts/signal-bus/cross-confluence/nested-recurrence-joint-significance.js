#!/usr/bin/env node
// iapaulo's question: what happens when the nested cross-timeframe cascade (Boom Hunter Long agreeing
// on a SLOWER timeframe, in sequence, before a full-sequence bullish OB) is combined with the rest of
// the validated SMC research -- specifically recurrence_count, the single strongest predictor found in
// this project (point-biserial ~0.29-0.31, p=0). Two questions, same discipline as
// ob-at-below-solid-structure-significance.js's recurrence-stratified interaction test:
//   1. Is "nested" just a proxy for "high recurrence" (i.e. do nested OBs simply happen to recur more)?
//   2. Does the nested effect (and the depth dose-response) survive INSIDE each recurrence stratum, and
//      does stacking both (nested AND high-recurrence) beat either alone?
//
// Reuses the exact full-sequence classification + sequential nesting logic from
// nested-cross-timeframe-significance.js (same OB population, same nested/depth definitions), joined
// against order_blocks.recurrence_count. Real touches + fixed-R methodology, permutation tests.
//
// Usage: node scripts/signal-bus/cross-confluence/nested-recurrence-joint-significance.js [--iterations=20000] [--r=1,1.5] [--pre-window=50] [--post-window=50] [--price-tolerance=0.01] [--nested-window=10]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const BOOM_DB_PATH = new URL("../../../data/signal-bus/boom-hunter.db", import.meta.url);
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
const NESTED_WINDOW_BARS = parseInt(args["nested-window"] || "10", 10);

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

// Identical to nested-cross-timeframe-significance.js -- same full-sequence OB population.
function classifyFullSequence(smcDb, boomDb, timeframe) {
  const obs = smcDb.prepare(
    "SELECT id, origin_bar_idx, origin_time, bar_high, bar_low, recurrence_count FROM order_blocks WHERE timeframe = ? AND side = 'bullish'",
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

// Identical sequential-nesting logic to nested-cross-timeframe-significance.js.
function checkNesting(boomDb, ob, ownTimeframe) {
  const ownIdx = LADDER_KEYS.indexOf(ownTimeframe);
  const slowerTfs = LADDER_KEYS.slice(0, ownIdx);
  const nestedOn = [];
  for (const tf of slowerTfs) {
    const windowSec = NESTED_WINDOW_BARS * BAR_DURATION_SEC[tf];
    const longs = boomDb.prepare(
      "SELECT bar_idx, time, price FROM events WHERE timeframe = ? AND type IN ('long_lime','long_blue','long_yellow','long_gray')",
    ).all(tf);
    const match = longs.some((l) => {
      if (l.time > ob.origin_time) return false;
      if (ob.origin_time - l.time > windowSec) return false;
      const tol = l.price * PRICE_TOLERANCE_PCT;
      return ob.bar_low - tol <= l.price && l.price <= ob.bar_high + tol;
    });
    if (match) nestedOn.push(tf);
  }
  return nestedOn;
}

async function buildOutcomes(candlesByTf, classificationByTf) {
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
    const classification = classificationByTf[tf]; // Map ob.id -> { nested, depth, recurrenceCount }
    for (const e of entries) {
      if (!classification.has(e.ob.id)) continue;
      const entryIdx = e.startBarIdx + 1;
      if (entryIdx >= candles.length) continue;
      const entryPrice = candles[entryIdx].o;
      const stopPrice = e.ob.bar_low;
      const risk = entryPrice - stopPrice;
      if (risk <= 0) continue;
      let outcome = null;
      const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
      const c = classification.get(e.ob.id);
      if (!obOutcomes.has(e.ob.id)) obOutcomes.set(e.ob.id, { nested: c.nested, depth: c.depth, recurrenceCount: c.recurrenceCount, timeframe: tf, byR: {} });
      const rec = obOutcomes.get(e.ob.id);
      for (const rMultiple of R_MULTIPLES) {
        const targetPrice = entryPrice + rMultiple * risk;
        let out2 = null;
        for (let j = entryIdx; j <= endCheck; j++) {
          const bar = candles[j];
          if (bar.l <= stopPrice) { out2 = 0; break; }
          if (bar.h >= targetPrice) { out2 = 1; break; }
        }
        if (out2 != null) { if (!rec.byR[rMultiple]) rec.byR[rMultiple] = []; rec.byR[rMultiple].push(out2); }
      }
    }
  }
  return [...obOutcomes.values()];
}

function statsFor(obs, rMultiple, predicate) {
  const wins = [];
  for (const o of obs) if (predicate(o) && o.byR[rMultiple]) wins.push(...o.byR[rMultiple]);
  return { n: wins.length, winRate: winRate(wins) };
}
function permTestR(obs, rMultiple, iterations, seed, predicateA) {
  const subset = obs.map((o) => ({ ...o, wins: o.byR[rMultiple] || [] })).filter((o) => o.wins.length > 0);
  return permutationTest(subset, iterations, seed, predicateA);
}

function fmtPct(x) { return x != null ? (x * 100).toFixed(1) + "%" : "n/a"; }
function fmtGap(t) { return t ? `gap=${(t.realGap * 100).toFixed(1)}pts p=${t.p.toFixed(4)}${t.p < 0.05 ? "*" : ""}` : "n/a"; }

async function runForRMultiple(rMultiple, obs, iterations, seed) {
  console.log(`\n=== ${rMultiple}R ===`);

  const highRec = (o) => o.recurrenceCount >= 2;
  const lowRec = (o) => o.recurrenceCount === 1;
  const nested = (o) => o.nested;
  const solo = (o) => !o.nested;

  console.log(`\n--- Is "nested" just a recurrence proxy? (recurrenceCount by nested/solo) ---`);
  const nestedObs = obs.filter(nested), soloObs = obs.filter(solo);
  const avgRec = (arr) => arr.length ? (arr.reduce((s, o) => s + o.recurrenceCount, 0) / arr.length).toFixed(2) : "n/a";
  console.log(`  nested: n(obs)=${nestedObs.length} avg recurrenceCount=${avgRec(nestedObs)}`);
  console.log(`  solo:   n(obs)=${soloObs.length} avg recurrenceCount=${avgRec(soloObs)}`);

  console.log(`\n--- nested effect, stratified by recurrence (does nesting survive controlling for recurrence?) ---`);
  const nestedInHighRec = permTestR(obs.filter(highRec), rMultiple, iterations, seed + 10, nested);
  const nestedInLowRec = permTestR(obs.filter(lowRec), rMultiple, iterations, seed + 11, nested);
  console.log(`  within HIGH recurrence (>=2): nested=${fmtPct(statsFor(obs.filter(highRec), rMultiple, nested).winRate)} solo=${fmtPct(statsFor(obs.filter(highRec), rMultiple, solo).winRate)} ${fmtGap(nestedInHighRec)}`);
  console.log(`  within LOW recurrence (=1):   nested=${fmtPct(statsFor(obs.filter(lowRec), rMultiple, nested).winRate)} solo=${fmtPct(statsFor(obs.filter(lowRec), rMultiple, solo).winRate)} ${fmtGap(nestedInLowRec)}`);

  console.log(`\n--- recurrence effect, stratified by nested/solo (does recurrence survive controlling for nesting?) ---`);
  const recInNested = permTestR(obs.filter(nested), rMultiple, iterations, seed + 12, highRec);
  const recInSolo = permTestR(obs.filter(solo), rMultiple, iterations, seed + 13, highRec);
  console.log(`  within NESTED: high-rec=${fmtPct(statsFor(obs.filter(nested), rMultiple, highRec).winRate)} low-rec=${fmtPct(statsFor(obs.filter(nested), rMultiple, lowRec).winRate)} ${fmtGap(recInNested)}`);
  console.log(`  within SOLO:   high-rec=${fmtPct(statsFor(obs.filter(solo), rMultiple, highRec).winRate)} low-rec=${fmtPct(statsFor(obs.filter(solo), rMultiple, lowRec).winRate)} ${fmtGap(recInSolo)}`);

  console.log(`\n--- 2x2 combined table (nested x recurrence) ---`);
  const cells = [
    ["nested + high-rec (best case)", (o) => nested(o) && highRec(o)],
    ["nested + low-rec", (o) => nested(o) && lowRec(o)],
    ["solo + high-rec", (o) => solo(o) && highRec(o)],
    ["solo + low-rec (worst case)", (o) => solo(o) && lowRec(o)],
  ];
  const cellStats = {};
  for (const [label, pred] of cells) {
    const s = statsFor(obs, rMultiple, pred);
    cellStats[label] = s;
    console.log(`  ${label.padEnd(30)} n=${String(s.n).padEnd(6)} winRate=${fmtPct(s.winRate)}`);
  }

  console.log(`\n--- best case (nested+high-rec) vs worst case (solo+low-rec) ---`);
  const bestVsWorst = permTestR(
    obs.filter((o) => (nested(o) && highRec(o)) || (solo(o) && lowRec(o))),
    rMultiple, iterations, seed + 14, (o) => nested(o) && highRec(o),
  );
  console.log(`  ${fmtGap(bestVsWorst)}`);

  console.log(`\n--- cascade depth within recurrence strata (dose-response, controlling for recurrence) ---`);
  const byDepthInStratum = {};
  for (const [stratLabel, stratPred] of [["high-rec", highRec], ["low-rec", lowRec]]) {
    const stratObs = obs.filter(stratPred);
    const maxDepth = stratObs.length ? Math.max(...stratObs.map((o) => o.depth), 0) : 0;
    const rows = [];
    for (let d = 0; d <= maxDepth; d++) {
      const s = statsFor(stratObs, rMultiple, (o) => o.depth === d);
      rows.push({ depth: d, ...s });
      console.log(`  [${stratLabel}] depth=${d}: n=${s.n}, winRate=${fmtPct(s.winRate)}`);
    }
    byDepthInStratum[stratLabel] = rows;
  }

  return {
    rMultiple,
    nestedAvgRecurrence: nestedObs.length ? nestedObs.reduce((s, o) => s + o.recurrenceCount, 0) / nestedObs.length : null,
    soloAvgRecurrence: soloObs.length ? soloObs.reduce((s, o) => s + o.recurrenceCount, 0) / soloObs.length : null,
    nestedInHighRec, nestedInLowRec, recInNested, recInSolo,
    cellStats, bestVsWorst, byDepthInStratum,
  };
}

async function main() {
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
      m.set(ob.id, { nested: nestedOn.length > 0, depth: nestedOn.length, recurrenceCount: ob.recurrence_count });
    }
    classificationByTf[tf] = m;
  }
  smcDb.close(); boomDb.close();

  const obs = await buildOutcomes(candlesByTf, classificationByTf);
  console.log(`${obs.length} full-sequence bullish order blocks in scope. [nested window=${NESTED_WINDOW_BARS} bars, pre=${PRE_WINDOW} post=${POST_WINDOW} tol=${PRICE_TOLERANCE_PCT}]`);

  const results = {};
  for (const r of R_MULTIPLES) results[`${r}R`] = await runForRMultiple(r, obs, ITERATIONS, SEED);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results, obCount: obs.length, preWindow: PRE_WINDOW, postWindow: POST_WINDOW, priceTolerance: PRICE_TOLERANCE_PCT, nestedWindowBars: NESTED_WINDOW_BARS, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `nested_recurrence_joint_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

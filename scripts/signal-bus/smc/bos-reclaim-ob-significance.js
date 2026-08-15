#!/usr/bin/env node
// The actual mechanism iapaulo has been describing, precisely: a swing BOS breaks structure one
// direction, price later RECLAIMS back across that same level (the break fails), and the order
// block that forms on the reclaim move is what confirms the structural change. NOT a static
// position check (OB near a structure line, tested in ob-at-below-solid-structure-significance.js
// and recurrence-structure-joint-significance.js -- both came back null/negative) -- a SEQUENCE:
// break, then reclaim, then the OB attached to the reclaim itself.
//
// Definition:
//   1. Swing (solid) BOS or CHoCH, side S, at price P, bar B.
//   2. Reclaim: price later closes back across P in the OPPOSITE direction within RECLAIM_WINDOW_BARS.
//   3. Attached OB: an order block of the OPPOSITE side to the original break (i.e., matching the
//      reclaim's direction), whose origin sits within ATTACH_BAR_GAP bars of the RECLAIM bar (not
//      the original break bar -- the OB confirms the reclaim, not the break itself).
// Compared against: OBs of the same side/timeframe attached to a break that has NOT been reclaimed
// (still holding, i.e. a genuine continuation setup) -- these are mechanically different scenarios
// and shouldn't be pooled.
//
// Real order_block_touches + fixed-R methodology throughout, matching recurrence-fixed-rr-
// significance.js -- not MFE. Full historical order-block set (ORDER_BLOCK_MAX_TRACKED raised
// 2026-08-08).
//
// Usage: node scripts/signal-bus/smc/bos-reclaim-ob-significance.js [--iterations=20000] [--r=1,1.5] [--reclaim-window=60] [--attach-gap=5]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const MAX_HOLD_BARS = 200;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULTIPLES = (args.r || "1,1.5").split(",").map(Number);
const RECLAIM_WINDOW_BARS = parseInt(args["reclaim-window"] || "60", 10);
const ATTACH_BAR_GAP = parseInt(args["attach-gap"] || "5", 10);

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

async function findReclaimEvents(smcDb, candlesByTf) {
  // Every swing CHoCH/BOS, either side, all timeframes -- find which ones get reclaimed (price
  // closes back across the break price, opposite direction) within RECLAIM_WINDOW_BARS.
  const events = smcDb.prepare(
    "SELECT timeframe, side, bar_idx as barIdx, time, price FROM structure_events WHERE scope = 'swing' AND type IN ('CHOCH','BOS')",
  ).all();
  const reclaims = []; // { timeframe, originalSide, reclaimBarIdx, reclaimTime }
  const noReclaim = [];
  for (const e of events) {
    const candles = candlesByTf[e.timeframe];
    if (!candles) continue;
    let reclaimBarIdx = null;
    for (let j = e.barIdx + 1; j <= Math.min(e.barIdx + RECLAIM_WINDOW_BARS, candles.length - 1); j++) {
      const c = candles[j].c;
      const reclaimed = e.side === "bullish" ? c < e.price : c > e.price; // bullish break reclaimed downward, bearish break reclaimed upward
      if (reclaimed) { reclaimBarIdx = j; break; }
    }
    if (reclaimBarIdx != null) {
      reclaims.push({ timeframe: e.timeframe, originalSide: e.side, reclaimBarIdx, breakBarIdx: e.barIdx });
    } else {
      noReclaim.push({ timeframe: e.timeframe, originalSide: e.side, breakBarIdx: e.barIdx });
    }
  }
  return { reclaims, noReclaim };
}

function classifyOBs(obRows, reclaims, noReclaim) {
  const byTfSide = new Map(); // key `${tf}_${obSide}` -> list of {barIdx}
  function bucket(list, tf, obSide) {
    const key = `${tf}_${obSide}`;
    if (!byTfSide.has(key)) byTfSide.set(key, []);
    return byTfSide.get(key);
  }
  const reclaimIndex = new Map(); // key `${tf}_${obSide}` -> [reclaimBarIdx,...]
  for (const r of reclaims) {
    const obSide = r.originalSide === "bullish" ? "bearish" : "bullish"; // OB confirming the reclaim is opposite the ORIGINAL break's side
    const key = `${r.timeframe}_${obSide}`;
    if (!reclaimIndex.has(key)) reclaimIndex.set(key, []);
    reclaimIndex.get(key).push(r.reclaimBarIdx);
  }
  const continuationIndex = new Map(); // OBs attached to a break that HELD (no reclaim) -- same side as the break itself
  for (const n of noReclaim) {
    const obSide = n.originalSide; // a held break's OWN side -- the continuation OB matches it directly
    const key = `${n.timeframe}_${obSide}`;
    if (!continuationIndex.has(key)) continuationIndex.set(key, []);
    continuationIndex.get(key).push(n.breakBarIdx);
  }

  const classification = new Map(); // ob.id -> "reclaim" | "continuation" | "neither"
  for (const ob of obRows) {
    const key = `${ob.timeframe}_${ob.side}`;
    const reclaimBars = reclaimIndex.get(key) || [];
    const contBars = continuationIndex.get(key) || [];
    const isReclaim = reclaimBars.some((b) => Math.abs(b - ob.origin_bar_idx) <= ATTACH_BAR_GAP);
    const isContinuation = !isReclaim && contBars.some((b) => Math.abs(b - ob.origin_bar_idx) <= ATTACH_BAR_GAP);
    classification.set(ob.id, isReclaim ? "reclaim" : isContinuation ? "continuation" : "neither");
  }
  return classification;
}

async function buildOutcomes(rMultiple, candlesByTf, classification) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const obRows = db.prepare("SELECT id, timeframe, side, bar_high, bar_low, recurrence_count FROM order_blocks").all();
  const touchRows = db.prepare("SELECT order_block_id, start_bar_idx FROM order_block_touches").all();
  db.close();

  const obById = new Map(obRows.map((o) => [o.id, o]));
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    if (!entriesByTf.has(ob.timeframe)) entriesByTf.set(ob.timeframe, []);
    entriesByTf.get(ob.timeframe).push({ startBarIdx: t.start_bar_idx, ob });
  }

  const obOutcomes = new Map();
  for (const [tf, entries] of entriesByTf) {
    const candles = candlesByTf[tf];
    for (const e of entries) {
      const entryIdx = e.startBarIdx + 1;
      if (entryIdx >= candles.length) continue;
      const entryPrice = candles[entryIdx].o;
      const side = e.ob.side === "bullish" ? "long" : "short";
      const stopPrice = e.ob.side === "bullish" ? e.ob.bar_low : e.ob.bar_high;
      const risk = Math.abs(entryPrice - stopPrice);
      if (risk <= 0) continue;
      const targetPrice = side === "long" ? entryPrice + rMultiple * risk : entryPrice - rMultiple * risk;
      let outcome = null;
      const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
      for (let j = entryIdx; j <= endCheck; j++) {
        const bar = candles[j];
        const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
        const hitTarget = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
        if (hitStop) { outcome = 0; break; }
        if (hitTarget) { outcome = 1; break; }
      }
      if (outcome == null) continue;
      if (!obOutcomes.has(e.ob.id)) {
        obOutcomes.set(e.ob.id, { recurrenceCount: e.ob.recurrence_count, classification: classification.get(e.ob.id), wins: [] });
      }
      obOutcomes.get(e.ob.id).wins.push(outcome);
    }
  }
  return [...obOutcomes.values()];
}

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
  return { realA, realB, realGap, p, n: permGaps.length };
}

async function runForRMultiple(rMultiple, candlesByTf, classification) {
  console.log(`\n=== ${rMultiple}R ===`);
  const obs = await buildOutcomes(rMultiple, candlesByTf, classification);
  const totalTrades = obs.reduce((s, o) => s + o.wins.length, 0);
  const byClass = { reclaim: 0, continuation: 0, neither: 0 };
  for (const o of obs) byClass[o.classification]++;
  console.log(`${obs.length} order blocks (reclaim=${byClass.reclaim}, continuation=${byClass.continuation}, neither=${byClass.neither}), ${totalTrades} resolved trades.`);

  const reclaimStats = groupStats(obs, (o) => o.classification === "reclaim");
  const continuationStats = groupStats(obs, (o) => o.classification === "continuation");
  const neitherStats = groupStats(obs, (o) => o.classification === "neither");
  console.log(`  reclaim OBs:      n=${reclaimStats.n}, winRate=${reclaimStats.winRate != null ? (reclaimStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  console.log(`  continuation OBs: n=${continuationStats.n}, winRate=${continuationStats.winRate != null ? (continuationStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  console.log(`  neither:          n=${neitherStats.n}, winRate=${neitherStats.winRate != null ? (neitherStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);

  const vsNeither = permutationTest(obs.filter((o) => o.classification !== "continuation"), ITERATIONS, SEED, (o) => o.classification === "reclaim");
  const vsContinuation = permutationTest(obs.filter((o) => o.classification !== "neither"), ITERATIONS, SEED + 1, (o) => o.classification === "reclaim");
  if (vsNeither) console.log(`\n  reclaim vs neither:      gap=${(vsNeither.realGap * 100).toFixed(1)}pts p=${vsNeither.p.toFixed(4)}${vsNeither.p < 0.05 ? "*" : ""}`);
  if (vsContinuation) console.log(`  reclaim vs continuation: gap=${(vsContinuation.realGap * 100).toFixed(1)}pts p=${vsContinuation.p.toFixed(4)}${vsContinuation.p < 0.05 ? "*" : ""}`);

  const highRecReclaim = permutationTest(obs.filter((o) => o.classification === "reclaim"), ITERATIONS, SEED + 2, (o) => o.recurrenceCount >= 2);
  if (highRecReclaim) console.log(`\n  within reclaim OBs, high vs low recurrence: gap=${(highRecReclaim.realGap * 100).toFixed(1)}pts p=${highRecReclaim.p.toFixed(4)}${highRecReclaim.p < 0.05 ? "*" : ""}`);

  return { rMultiple, obCount: obs.length, tradeCount: totalTrades, byClass, reclaimStats, continuationStats, neitherStats, vsNeither, vsContinuation, highRecReclaim };
}

async function main() {
  const smcDb = new DatabaseSync(DB_PATH, { readOnly: true });
  const candlesByTf = {};
  for (const tf of LADDER_KEYS) candlesByTf[tf] = await loadCandles(tf);

  console.log("Finding swing BOS/CHoCH reclaim events across full history...");
  const { reclaims, noReclaim } = await findReclaimEvents(smcDb, candlesByTf);
  console.log(`${reclaims.length + noReclaim.length} total swing structure events: ${reclaims.length} reclaimed within ${RECLAIM_WINDOW_BARS} bars, ${noReclaim.length} held.`);

  const obRows = smcDb.prepare("SELECT id, timeframe, side, origin_bar_idx FROM order_blocks").all();
  smcDb.close();
  const classification = classifyOBs(obRows, reclaims, noReclaim);

  const results = {};
  for (const r of R_MULTIPLES) results[`${r}R`] = await runForRMultiple(r, candlesByTf, classification);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results, reclaimWindowBars: RECLAIM_WINDOW_BARS, attachBarGap: ATTACH_BAR_GAP, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `bos_reclaim_ob_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

#!/usr/bin/env node
// Nested cross-timeframe confirmation on Cipher A's bullCandle -- the best-motivated Cipher A
// target (register #55: "the broadest multi-timeframe replication found anywhere in this project,"
// 7 of 8 timeframes, descriptive-significant but never cost-tested or nested). Mirrors the
// corrected, sequential methodology from nested-cross-timeframe-significance.js/#61 exactly: a
// SLOWER timeframe's own bullCandle must fire FIRST (real-time window scaled to that slower TF's
// own bar duration, price-anchored), not just be symmetric-nearby -- the fix iapaulo forced onto
// the original Boom Hunter version applies here from the start, not bolted on after a wrong first
// attempt.
//
// No natural OB/stop exists for a raw candle-pattern signal -- same house convention as EOT3/
// divergence (0.6x ATR(14) risk, fixed-R, race-to-target-or-stop), not invented fresh.
//
// Usage: node scripts/signal-bus/cross-confluence/cipher-a-bullcandle-nested-significance.js [--iterations=20000] [--r=1,1.5] [--price-tolerance=0.01] [--nested-window=10]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const CIPHER_A_DB_PATH = new URL("../../../data/signal-bus/cipher-a.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const ATR_LEN = 14;
const ATR_MULT = 0.6;
const MAX_HOLD_BARS = 200;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULTIPLES = (args.r || "1,1.5").split(",").map(Number);
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
function atr(candles, length) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < length) return out;
  let seed = 0;
  for (let i = 0; i < length; i++) seed += tr[i];
  out[length - 1] = seed / length;
  for (let i = length; i < candles.length; i++) out[i] = (out[i - 1] * (length - 1) + tr[i]) / length;
  return out;
}
function simulateFixedR(candles, entryIdx, stopPrice, targetPrice) {
  const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= endCheck; j++) {
    const bar = candles[j];
    if (bar.l <= stopPrice) return 0;
    if (bar.h >= targetPrice) return 1;
  }
  return null;
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
function fmtGap(t) { return t ? `gap=${(t.realGap * 100).toFixed(1)}pts p=${t.p.toFixed(4)}${t.p < 0.05 ? "*" : ""}` : "n/a"; }

// eventsByTf: pre-loaded Map(tf -> events[]) for ALL timeframes, loaded once -- avoids re-querying
// per event (the mistake caught and fixed in build-boom-confluence.js earlier this session, same
// root cause: ~O(numEvents * numSlowerTfs) DB queries is catastrophic on 5m's ~98k bull_candle rows).
function checkNesting(eventsByTf, ev, ownTimeframe) {
  const ownIdx = LADDER_KEYS.indexOf(ownTimeframe);
  const slowerTfs = LADDER_KEYS.slice(0, ownIdx);
  const nestedOn = [];
  for (const tf of slowerTfs) {
    const windowSec = NESTED_WINDOW_BARS * BAR_DURATION_SEC[tf];
    const candidates = eventsByTf.get(tf);
    const match = candidates.some((c) => {
      if (c.time > ev.time) return false;
      if (ev.time - c.time > windowSec) return false;
      const tol = c.price * PRICE_TOLERANCE_PCT;
      return ev.price - tol <= c.price && c.price <= ev.price + tol;
    });
    if (match) nestedOn.push(tf);
  }
  return nestedOn;
}

async function buildOutcomes(rMultiple, candlesByTf, atrByTf) {
  const db = new DatabaseSync(CIPHER_A_DB_PATH, { readOnly: true });
  const eventsByTf = new Map();
  for (const tf of LADDER_KEYS) eventsByTf.set(tf, db.prepare("SELECT bar_idx, time, price FROM events WHERE timeframe = ? AND type = 'bull_candle'").all(tf));
  db.close();

  const results = [];
  for (const tf of LADDER_KEYS) {
    const events = eventsByTf.get(tf);
    const candles = candlesByTf[tf], atr14 = atrByTf[tf];
    for (const ev of events) {
      const entryIdx = ev.bar_idx + 1;
      if (entryIdx >= candles.length) continue;
      const atrAtSignal = atr14[ev.bar_idx];
      if (!Number.isFinite(atrAtSignal) || atrAtSignal <= 0) continue;
      const entryPrice = candles[entryIdx].o;
      const risk = ATR_MULT * atrAtSignal;
      const stopPrice = entryPrice - risk, targetPrice = entryPrice + rMultiple * risk;
      const outcome = simulateFixedR(candles, entryIdx, stopPrice, targetPrice);
      if (outcome == null) continue;
      const nestedOn = checkNesting(eventsByTf, ev, tf);
      results.push({ nested: nestedOn.length > 0, depth: nestedOn.length, timeframe: tf, wins: [outcome] });
    }
  }
  return results;
}

async function runForRMultiple(rMultiple, candlesByTf, atrByTf, iterations, seed) {
  console.log(`\n=== ${rMultiple}R ===`);
  const obs = await buildOutcomes(rMultiple, candlesByTf, atrByTf);
  const totalTrades = obs.reduce((s, o) => s + o.wins.length, 0);
  const nNested = obs.filter((o) => o.nested).length, nSolo = obs.filter((o) => !o.nested).length;
  console.log(`${obs.length} bullCandle events (nested=${nNested}, solo=${nSolo}), ${totalTrades} resolved trades.`);

  const test = permutationTest(obs, iterations, seed, (o) => o.nested);
  const nestedStats = groupStats(obs, (o) => o.nested), soloStats = groupStats(obs, (o) => !o.nested);
  console.log(`  nested: n=${nestedStats.n} winRate=${nestedStats.winRate != null ? (nestedStats.winRate * 100).toFixed(1) + "%" : "n/a"}  solo: n=${soloStats.n} winRate=${soloStats.winRate != null ? (soloStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  if (test) console.log(`  nested vs solo: ${fmtGap(test)}`);

  console.log(`  --- by cascade depth ---`);
  // Manual loop, not Math.max(...obs.map(...)) -- spreading 100k+ elements into call arguments
  // hits the engine's argument-count limit (same root cause fixed repeatedly in smc/*.js earlier
  // this session, missed here on the first pass).
  let maxDepth = 0;
  for (const o of obs) if (o.depth > maxDepth) maxDepth = o.depth;
  const depthStats = [];
  for (let d = 0; d <= maxDepth; d++) {
    const s = groupStats(obs, (o) => o.depth === d);
    depthStats.push({ depth: d, ...s });
    console.log(`    depth=${d}: n=${s.n} winRate=${s.winRate != null ? (s.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  }

  console.log(`  --- per timeframe ---`);
  const byTf = {};
  for (const tf of LADDER_KEYS) {
    const tfObs = obs.filter((o) => o.timeframe === tf);
    if (tfObs.length === 0) continue;
    const tfTest = permutationTest(tfObs, iterations, seed + 1000, (o) => o.nested);
    byTf[tf] = tfTest;
    console.log(`    ${tf.padEnd(4)} n=${tfObs.length} ${fmtGap(tfTest)}`);
  }

  return { rMultiple, obCount: obs.length, tradeCount: totalTrades, nNested, nSolo, test, depthStats, byTf };
}

async function main() {
  const candlesByTf = {}, atrByTf = {};
  for (const tf of LADDER_KEYS) { candlesByTf[tf] = await loadCandles(tf); atrByTf[tf] = atr(candlesByTf[tf], ATR_LEN); }

  const results = {};
  for (const r of R_MULTIPLES) results[`${r}R`] = await runForRMultiple(r, candlesByTf, atrByTf, ITERATIONS, SEED);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results, priceTolerance: PRICE_TOLERANCE_PCT, nestedWindowBars: NESTED_WINDOW_BARS, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `cipher_a_bullcandle_nested_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

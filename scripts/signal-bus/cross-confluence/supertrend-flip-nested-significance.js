#!/usr/bin/env node
// Nested cross-timeframe confirmation on Adaptive SuperTrend flips -- the highest-value test in
// this plan. Register #10/#11: a raw, single-timeframe SuperTrend flip is FALSIFIED as a standalone
// edge (multiple-testing corrected, nothing clears real significance alone). This directly
// re-litigates that verdict under the SAME "nested confirmation rescues a weak/falsified single-TF
// signal" pattern already validated three times this project (#38 -- Cipher B buySignal/sellSignal,
// the STRONGEST finding in that whole investigation; #59/#68 -- Cipher B divergence; #61/#69 --
// Boom Hunter). Same corrected, sequential methodology (slower TF's own flip, SAME direction, must
// fire FIRST within a TF-scaled window -- not #61's original symmetric-proximity mistake, applied
// correctly from the start here).
//
// No natural OB/stop for a SuperTrend flip -- same house convention as EOT3/divergence/bullCandle
// (0.6x ATR(14) risk, fixed-R). Side-aware (long on a bullish flip, short on a bearish flip),
// unlike bullCandle/EOT3 which were long-only.
//
// Usage: node scripts/signal-bus/cross-confluence/supertrend-flip-nested-significance.js [--iterations=20000] [--r=1,1.5] [--price-tolerance=0.01] [--nested-window=10]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const ST_DB_PATH = new URL("../../../data/signal-bus/adaptive-supertrend.db", import.meta.url);
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
function simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice) {
  const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= endCheck; j++) {
    const bar = candles[j];
    const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
    const hitTarget = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
    if (hitStop) return 0;
    if (hitTarget) return 1;
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

// Same-direction confirmation only: a bullish flip is confirmed by a slower TF's own bullish flip
// (not just "any flip"), matching how every other nested test in this project requires same-side
// agreement, not direction-agnostic proximity.
function checkNesting(eventsByTf, ev, ownTimeframe) {
  const ownIdx = LADDER_KEYS.indexOf(ownTimeframe);
  const slowerTfs = LADDER_KEYS.slice(0, ownIdx);
  const nestedOn = [];
  for (const tf of slowerTfs) {
    const windowSec = NESTED_WINDOW_BARS * BAR_DURATION_SEC[tf];
    const candidates = eventsByTf.get(tf).filter((c) => c.direction === ev.direction);
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
  const db = new DatabaseSync(ST_DB_PATH, { readOnly: true });
  const eventsByTf = new Map();
  for (const tf of LADDER_KEYS) eventsByTf.set(tf, db.prepare("SELECT bar_idx, time, price, direction FROM events WHERE timeframe = ?").all(tf));
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
      const side = ev.direction === "bullish" ? "long" : "short";
      const entryPrice = candles[entryIdx].o;
      const risk = ATR_MULT * atrAtSignal;
      const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
      const targetPrice = side === "long" ? entryPrice + rMultiple * risk : entryPrice - rMultiple * risk;
      const outcome = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
      if (outcome == null) continue;
      const nestedOn = checkNesting(eventsByTf, ev, tf);
      results.push({ nested: nestedOn.length > 0, depth: nestedOn.length, timeframe: tf, side: ev.direction, wins: [outcome] });
    }
  }
  return results;
}

async function runForRMultiple(rMultiple, candlesByTf, atrByTf, iterations, seed) {
  console.log(`\n=== ${rMultiple}R ===`);
  const obs = await buildOutcomes(rMultiple, candlesByTf, atrByTf);
  const totalTrades = obs.reduce((s, o) => s + o.wins.length, 0);
  const nNested = obs.filter((o) => o.nested).length, nSolo = obs.filter((o) => !o.nested).length;
  console.log(`${obs.length} SuperTrend flip events (nested=${nNested}, solo=${nSolo}), ${totalTrades} resolved trades.`);

  const test = permutationTest(obs, iterations, seed, (o) => o.nested);
  const nestedStats = groupStats(obs, (o) => o.nested), soloStats = groupStats(obs, (o) => !o.nested);
  console.log(`  nested: n=${nestedStats.n} winRate=${nestedStats.winRate != null ? (nestedStats.winRate * 100).toFixed(1) + "%" : "n/a"}  solo: n=${soloStats.n} winRate=${soloStats.winRate != null ? (soloStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  if (test) console.log(`  nested vs solo: ${fmtGap(test)}`);

  console.log(`  --- by cascade depth ---`);
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

  console.log(`  --- by side ---`);
  const bySide = {};
  for (const side of ["bullish", "bearish"]) {
    const sideObs = obs.filter((o) => o.side === side);
    const t = permutationTest(sideObs, iterations, seed + 2000, (o) => o.nested);
    bySide[side] = t;
    console.log(`    ${side.padEnd(8)} n=${sideObs.length} ${fmtGap(t)}`);
  }

  return { rMultiple, obCount: obs.length, tradeCount: totalTrades, nNested, nSolo, test, depthStats, byTf, bySide };
}

async function main() {
  const candlesByTf = {}, atrByTf = {};
  for (const tf of LADDER_KEYS) { candlesByTf[tf] = await loadCandles(tf); atrByTf[tf] = atr(candlesByTf[tf], ATR_LEN); }

  const results = {};
  for (const r of R_MULTIPLES) results[`${r}R`] = await runForRMultiple(r, candlesByTf, atrByTf, ITERATIONS, SEED);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results, priceTolerance: PRICE_TOLERANCE_PCT, nestedWindowBars: NESTED_WINDOW_BARS, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `supertrend_flip_nested_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

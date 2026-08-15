#!/usr/bin/env node
// Cross-INDICATOR confluence test (not the within-indicator timeframe nesting used in #71/#77):
// does Cipher A's own signal, gated by Adaptive SuperTrend's CURRENT directional state on the SAME
// timeframe, produce a better outcome than an ungated signal? Requested directly by iapaulo after
// #78 found every within-indicator nested candidate trade-construction-blocked -- this tests the
// "build them together" idea that was flagged but never built.
//
// Confluence definition: at the Cipher A event's bar, look up Adaptive SuperTrend's last flip at or
// before that bar on the SAME timeframe -- its direction is the "current" SuperTrend state. A
// bullish Cipher A event confluences with a bullish SuperTrend state; bearish with bearish.
// Same permutation methodology, same 0.6xATR(14) fixed-R construction as #71/#77/#78.
//
// Usage: node scripts/signal-bus/cross-confluence/cipher-a-supertrend-confluence-significance.js --signal-type=red_cross [--iterations=20000] [--r=1,1.5]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const CIPHER_A_DB_PATH = new URL("../../../data/signal-bus/cipher-a.db", import.meta.url);
const SUPERTREND_DB_PATH = new URL("../../../data/signal-bus/adaptive-supertrend.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const ATR_LEN = 14;
const ATR_MULT = 0.6;
const MAX_HOLD_BARS = 200;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const SIGNAL_TYPE = args["signal-type"];
if (!SIGNAL_TYPE) { console.error("Fatal: --signal-type is required"); process.exit(1); }
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULTIPLES = (args.r || "1,1.5").split(",").map(Number);

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

// Find SuperTrend's direction "in force" at ev's bar on the same timeframe: the last flip whose
// bar_idx <= ev.bar_idx. Flips are pre-sorted ascending by bar_idx per timeframe.
function currentDirection(sortedFlips, barIdx) {
  let lo = 0, hi = sortedFlips.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedFlips[mid].bar_idx <= barIdx) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans === -1 ? null : sortedFlips[ans].direction;
}

async function buildOutcomes(rMultiple, candlesByTf, atrByTf) {
  const cipherDb = new DatabaseSync(CIPHER_A_DB_PATH, { readOnly: true });
  const stDb = new DatabaseSync(SUPERTREND_DB_PATH, { readOnly: true });
  const eventsByTf = new Map(), flipsByTf = new Map();
  for (const tf of LADDER_KEYS) {
    eventsByTf.set(tf, cipherDb.prepare("SELECT bar_idx, time, price, side FROM events WHERE timeframe = ? AND type = ?").all(tf, SIGNAL_TYPE));
    flipsByTf.set(tf, stDb.prepare("SELECT bar_idx, direction FROM events WHERE timeframe = ? ORDER BY bar_idx ASC").all(tf));
  }
  cipherDb.close(); stDb.close();

  const results = [];
  for (const tf of LADDER_KEYS) {
    const events = eventsByTf.get(tf), flips = flipsByTf.get(tf);
    const candles = candlesByTf[tf], atr14 = atrByTf[tf];
    for (const ev of events) {
      const entryIdx = ev.bar_idx + 1;
      if (entryIdx >= candles.length) continue;
      const atrAtSignal = atr14[ev.bar_idx];
      if (!Number.isFinite(atrAtSignal) || atrAtSignal <= 0) continue;
      const stDir = currentDirection(flips, ev.bar_idx);
      if (stDir == null) continue;
      const side = ev.side === "bullish" ? "long" : "short";
      const entryPrice = candles[entryIdx].o;
      const risk = ATR_MULT * atrAtSignal;
      const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
      const targetPrice = side === "long" ? entryPrice + rMultiple * risk : entryPrice - rMultiple * risk;
      const outcome = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
      if (outcome == null) continue;
      const confluence = stDir === ev.side;
      results.push({ confluence, timeframe: tf, side: ev.side, wins: [outcome] });
    }
  }
  return results;
}

async function runForRMultiple(rMultiple, candlesByTf, atrByTf, iterations, seed) {
  console.log(`\n=== ${rMultiple}R ===`);
  const obs = await buildOutcomes(rMultiple, candlesByTf, atrByTf);
  const totalTrades = obs.reduce((s, o) => s + o.wins.length, 0);
  const nConf = obs.filter((o) => o.confluence).length, nNo = obs.filter((o) => !o.confluence).length;
  console.log(`${obs.length} ${SIGNAL_TYPE} events with a known SuperTrend state (confluence=${nConf}, no-confluence=${nNo}), ${totalTrades} resolved trades.`);
  if (obs.length < 30) { console.log("  too thin, skipping stats"); return { rMultiple, obCount: obs.length, test: null }; }

  const test = permutationTest(obs, iterations, seed, (o) => o.confluence);
  const confStats = groupStats(obs, (o) => o.confluence), noStats = groupStats(obs, (o) => !o.confluence);
  console.log(`  confluence: n=${confStats.n} winRate=${confStats.winRate != null ? (confStats.winRate * 100).toFixed(1) + "%" : "n/a"}  no-confluence: n=${noStats.n} winRate=${noStats.winRate != null ? (noStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  if (test) console.log(`  confluence vs no-confluence: ${fmtGap(test)}`);

  console.log(`  --- per timeframe ---`);
  const byTf = {};
  for (const tf of LADDER_KEYS) {
    const tfObs = obs.filter((o) => o.timeframe === tf);
    if (tfObs.length === 0) continue;
    const tfTest = permutationTest(tfObs, iterations, seed + 1000, (o) => o.confluence);
    byTf[tf] = tfTest;
    console.log(`    ${tf.padEnd(4)} n=${tfObs.length} ${fmtGap(tfTest)}`);
  }

  return { rMultiple, obCount: obs.length, tradeCount: totalTrades, nConf, nNo, test, byTf };
}

async function main() {
  const candlesByTf = {}, atrByTf = {};
  for (const tf of LADDER_KEYS) { candlesByTf[tf] = await loadCandles(tf); atrByTf[tf] = atr(candlesByTf[tf], ATR_LEN); }

  const results = {};
  for (const r of R_MULTIPLES) results[`${r}R`] = await runForRMultiple(r, candlesByTf, atrByTf, ITERATIONS, SEED);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { signalType: SIGNAL_TYPE, results, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `cipher_a_${SIGNAL_TYPE}_supertrend_confluence_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

#!/usr/bin/env node
// Validates the specific condition iapaulo asked for directly: an order block AT OR BELOW a solid
// (swing-scope) CHoCH/BOS -- price ordering (ob.barHigh <= structure.price for bullish, ob.barLow >=
// structure.price for bearish, equality counted as "at"), scope='swing' only ("solid"), within a
// reasonable time window of the OB's origin (60 bars -- the window this exact definition validated
// under in ob-structure-confluence-significance.js on the old, capped dataset). This is a DIFFERENT
// condition from the bar-adjacency "attached" test that just came back negative at full power --
// price ordering, not bar-gap, and a real window instead of gap<=2.
//
// Same real-touches, fixed-R methodology as recurrence-fixed-rr-significance.js (not MFE), now
// running against the full, uncapped historical order-block set (ORDER_BLOCK_MAX_TRACKED raised
// 2026-08-08 -- see calc.js). Tests the condition alone, then cross-tabulated with recurrence_count,
// same interaction-test discipline as recurrence-structure-joint-significance.js.
//
// Usage: node scripts/signal-bus/smc/ob-at-below-solid-structure-significance.js [--iterations=20000] [--r=1,1.5] [--window-bars=60]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const MAX_HOLD_BARS = 200;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULTIPLES = (args.r || "1,1.5").split(",").map(Number);
const WINDOW_BARS = parseInt(args["window-bars"] || "60", 10);

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

// Price-ordering attachment: nearest opposite-side SOLID (swing) CHoCH/BOS such that the OB's zone
// sits entirely at-or-beyond that structure price, within WINDOW_BARS of the OB's origin.
function loadAtBelowAttachment(smcDb, obRows) {
  const byTf = new Map();
  for (const ob of obRows) {
    if (!byTf.has(ob.timeframe)) byTf.set(ob.timeframe, []);
    byTf.get(ob.timeframe).push(ob);
  }
  const attached = new Map();
  for (const [tf, obs] of byTf) {
    const windowSec = WINDOW_BARS * BAR_DURATION_SEC[tf];
    for (const side of ["bullish", "bearish"]) {
      const structSide = side === "bullish" ? "bearish" : "bullish";
      const structureEvents = smcDb.prepare(
        "SELECT time, price FROM structure_events WHERE timeframe = ? AND scope = 'swing' AND side = ? AND type IN ('CHOCH','BOS')",
      ).all(tf, structSide);
      for (const ob of obs.filter((o) => o.side === side)) {
        const qualifies = structureEvents.some((s) => {
          if (Math.abs(s.time - ob.origin_time) > windowSec) return false;
          return side === "bullish" ? ob.bar_high <= s.price : ob.bar_low >= s.price;
        });
        attached.set(ob.id, qualifies);
      }
    }
  }
  return attached;
}

async function buildOutcomes(rMultiple) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const obRows = db.prepare("SELECT id, timeframe, side, bar_high, bar_low, origin_time, recurrence_count FROM order_blocks").all();
  const attached = loadAtBelowAttachment(db, obRows);
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
    const candles = await loadCandles(tf);
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
        obOutcomes.set(e.ob.id, { recurrenceCount: e.ob.recurrence_count, attached: attached.get(e.ob.id) || false, wins: [] });
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

function permutationTest(obsSubset, iterations, seed, field) {
  const realAttached = groupStats(obsSubset, (o) => o[field]).winRate;
  const realUnattached = groupStats(obsSubset, (o) => !o[field]).winRate;
  if (realAttached == null || realUnattached == null) return null;
  const realGap = realAttached - realUnattached;

  const labels = obsSubset.map((o) => o[field]);
  const rng = mulberry32(seed);
  const permGaps = [];
  for (let i = 0; i < iterations; i++) {
    const shuffled = shuffle(labels, rng);
    let winsA = 0, nA = 0, winsB = 0, nB = 0;
    for (let j = 0; j < obsSubset.length; j++) {
      const w = obsSubset[j].wins;
      if (shuffled[j]) { winsA += w.reduce((s, x) => s + x, 0); nA += w.length; }
      else { winsB += w.reduce((s, x) => s + x, 0); nB += w.length; }
    }
    if (nA === 0 || nB === 0) continue;
    permGaps.push(winsA / nA - winsB / nB);
  }
  permGaps.sort((a, b) => a - b);
  const p = permGaps.filter((g) => g >= realGap).length / permGaps.length;
  return { realAttached, realUnattached, realGap, p, n: permGaps.length };
}

async function runForRMultiple(rMultiple) {
  console.log(`\n=== ${rMultiple}R ===`);
  const obs = await buildOutcomes(rMultiple);
  const totalTrades = obs.reduce((s, o) => s + o.wins.length, 0);
  console.log(`${obs.length} order blocks, ${totalTrades} resolved trades.`);

  const overall = permutationTest(obs, ITERATIONS, SEED, "attached");
  console.log(`\nOverall (OB at-or-below solid CHoCH/BOS vs. not, window=${WINDOW_BARS} bars):`);
  console.log(`  attached: n=${groupStats(obs, (o) => o.attached).n}, winRate=${(overall.realAttached * 100).toFixed(1)}%`);
  console.log(`  not attached: n=${groupStats(obs, (o) => !o.attached).n}, winRate=${(overall.realUnattached * 100).toFixed(1)}%`);
  console.log(`  gap=${(overall.realGap * 100).toFixed(1)}pts, p=${overall.p.toFixed(4)}${overall.p < 0.05 ? "*" : ""}`);

  const highRecurrence = (o) => o.recurrenceCount >= 2;
  const lowRecurrence = (o) => o.recurrenceCount === 1;
  const highRecObs = obs.filter(highRecurrence), lowRecObs = obs.filter(lowRecurrence);
  const highInt = permutationTest(highRecObs, ITERATIONS, SEED + 1, "attached");
  const lowInt = permutationTest(lowRecObs, ITERATIONS, SEED + 2, "attached");
  console.log(`\nWithin recurrence strata:`);
  if (highInt) console.log(`  high-recurrence: attached=${(highInt.realAttached * 100).toFixed(1)}% unattached=${(highInt.realUnattached * 100).toFixed(1)}% gap=${(highInt.realGap * 100).toFixed(1)}pts p=${highInt.p.toFixed(4)}${highInt.p < 0.05 ? "*" : ""}`);
  if (lowInt) console.log(`  low-recurrence:  attached=${(lowInt.realAttached * 100).toFixed(1)}% unattached=${(lowInt.realUnattached * 100).toFixed(1)}% gap=${(lowInt.realGap * 100).toFixed(1)}pts p=${lowInt.p.toFixed(4)}${lowInt.p < 0.05 ? "*" : ""}`);

  return { rMultiple, obCount: obs.length, tradeCount: totalTrades, overall, highRecurrenceInteraction: highInt, lowRecurrenceInteraction: lowInt };
}

async function main() {
  const results = {};
  for (const r of R_MULTIPLES) results[`${r}R`] = await runForRMultiple(r);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results, windowBars: WINDOW_BARS, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `ob_at_below_solid_structure_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

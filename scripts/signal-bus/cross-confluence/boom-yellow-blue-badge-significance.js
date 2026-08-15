#!/usr/bin/env node
// iapaulo's refinement: Boom Hunter's yellow/blue Long signals are "sometimes accompanied by a
// [D4M] badge, sometimes not, which may be significant." A badge is a DIFFERENT, more specific D4M
// concept than the "zone" tested in #63 -- zones are promoted glow LEVELS (a price), badges are a
// per-BAR event requiring >=3 of 4 enabled indicators to show a regular divergence simultaneously
// (divergence-for-many/calc.js), no price level of their own. Never tested against Boom Hunter
// before. Restricted to yellow/blue specifically, per iapaulo's own framing (not lime/gray/enter4,
// though those are trivially addable via TIERS below).
//
// Reuses the validated full-sequence classification (#60) restricted to yellow/blue, extended to
// also capture the MATCHING Long event's own bar_idx (needed to check badge proximity against the
// actual triggering signal, not the OB). "Accompanied by a badge" = a same-side (bullish) D4M
// badge fired within BADGE_WINDOW_BARS of that Long event, same timeframe -- symmetric window
// (badges reflect simultaneous oscillator confluence, not a before/after sequence like the nested-
// cascade tests). Same real-touches + fixed-R methodology as the rest of this suite.
//
// Usage: node scripts/signal-bus/cross-confluence/boom-yellow-blue-badge-significance.js [--iterations=20000] [--r=1,1.5] [--pre-window=50] [--post-window=50] [--price-tolerance=0.01] [--badge-window=10]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const BOOM_DB_PATH = new URL("../../../data/signal-bus/boom-hunter.db", import.meta.url);
const D4M_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const MAX_HOLD_BARS = 200;
const TIERS = ["long_yellow", "long_blue"]; // iapaulo's own framing -- lime/gray/enter4 excluded deliberately
const TIER_LABEL = { long_yellow: "yellow", long_blue: "blue" };

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULTIPLES = (args.r || "1,1.5").split(",").map(Number);
const PRE_WINDOW = parseInt(args["pre-window"] || "50", 10);
const POST_WINDOW = parseInt(args["post-window"] || "50", 10);
const PRICE_TOLERANCE_PCT = parseFloat(args["price-tolerance"] || "0.01");
const BADGE_WINDOW_BARS = parseInt(args["badge-window"] || "10", 10);

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
function fmtPct(x) { return x != null ? (x * 100).toFixed(1) + "%" : "n/a"; }
function fmtGap(t) { return t ? `gap=${(t.realGap * 100).toFixed(1)}pts p=${t.p.toFixed(4)}${t.p < 0.05 ? "*" : ""}` : "n/a"; }

// Like classifyFullSequence elsewhere, but restricted to yellow/blue and returns the MATCHING
// Long event's own bar_idx (needed for the badge-proximity check, not just which tier it was).
function classifyYellowBlueFullSequence(smcDb, boomDb, timeframe) {
  const obs = smcDb.prepare(
    "SELECT id, origin_bar_idx, origin_time, bar_high, bar_low, recurrence_count FROM order_blocks WHERE timeframe = ? AND side = 'bullish'",
  ).all(timeframe);
  const continuations = boomDb.prepare("SELECT bar_idx FROM events WHERE timeframe = ? AND type = 'continuation'").all(timeframe).map((r) => r.bar_idx);
  const longsByType = new Map();
  for (const type of TIERS) longsByType.set(type, boomDb.prepare("SELECT bar_idx, price FROM events WHERE timeframe = ? AND type = ?").all(timeframe, type));

  const fullOBs = [];
  for (const ob of obs) {
    let matched = null; // { tier, longBarIdx }
    for (const type of TIERS) {
      const hit = longsByType.get(type).find((l) => {
        if (l.bar_idx > ob.origin_bar_idx || ob.origin_bar_idx - l.bar_idx > PRE_WINDOW) return false;
        const tol = l.price * PRICE_TOLERANCE_PCT;
        return ob.bar_low - tol <= l.price && l.price <= ob.bar_high + tol;
      });
      if (hit) { matched = { tier: TIER_LABEL[type], longBarIdx: hit.bar_idx }; break; }
    }
    if (!matched) continue;
    const hasContinuationAfter = continuations.some((c) => c >= ob.origin_bar_idx && c - ob.origin_bar_idx <= POST_WINDOW);
    if (hasContinuationAfter) fullOBs.push({ ...ob, tier: matched.tier, longBarIdx: matched.longBarIdx });
  }
  return fullOBs;
}

function hasNearbyBadge(badges, longBarIdx) {
  return badges.some((b) => Math.abs(b.bar_idx - longBarIdx) <= BADGE_WINDOW_BARS);
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
    const classification = classificationByTf[tf]; // Map ob.id -> { hasBadge, tier, recurrenceCount }
    for (const e of entries) {
      if (!classification.has(e.ob.id)) continue;
      const entryIdx = e.startBarIdx + 1;
      if (entryIdx >= candles.length) continue;
      const entryPrice = candles[entryIdx].o;
      const stopPrice = e.ob.bar_low;
      const risk = entryPrice - stopPrice;
      if (risk <= 0) continue;
      const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
      const c = classification.get(e.ob.id);
      if (!obOutcomes.has(e.ob.id)) obOutcomes.set(e.ob.id, { hasBadge: c.hasBadge, tier: c.tier, recurrenceCount: c.recurrenceCount, timeframe: tf, byR: {} });
      const rec = obOutcomes.get(e.ob.id);
      for (const rMultiple of R_MULTIPLES) {
        const targetPrice = entryPrice + rMultiple * risk;
        let outcome = null;
        for (let j = entryIdx; j <= endCheck; j++) {
          const bar = candles[j];
          if (bar.l <= stopPrice) { outcome = 0; break; }
          if (bar.h >= targetPrice) { outcome = 1; break; }
        }
        if (outcome != null) { if (!rec.byR[rMultiple]) rec.byR[rMultiple] = []; rec.byR[rMultiple].push(outcome); }
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

async function runForRMultiple(rMultiple, obs, iterations, seed) {
  console.log(`\n=== ${rMultiple}R ===`);
  const hasBadge = (o) => o.hasBadge;

  const overall = permTestR(obs, rMultiple, iterations, seed, hasBadge);
  console.log(`Yellow/blue full-sequence Boom Hunter OBs: badge-accompanied vs not (badge window=${BADGE_WINDOW_BARS} bars)`);
  console.log(`  badge-accompanied: n=${statsFor(obs, rMultiple, hasBadge).n}, winRate=${fmtPct(statsFor(obs, rMultiple, hasBadge).winRate)}`);
  console.log(`  not:                n=${statsFor(obs, rMultiple, (o) => !o.hasBadge).n}, winRate=${fmtPct(statsFor(obs, rMultiple, (o) => !o.hasBadge).winRate)}`);
  console.log(`  ${fmtGap(overall)}`);

  console.log(`\n  --- stratified by recurrence ---`);
  const highRec = (o) => o.recurrenceCount >= 2, lowRec = (o) => o.recurrenceCount === 1;
  const inHigh = permTestR(obs.filter(highRec), rMultiple, iterations, seed + 1, hasBadge);
  const inLow = permTestR(obs.filter(lowRec), rMultiple, iterations, seed + 2, hasBadge);
  console.log(`  within HIGH recurrence (>=2): ${fmtGap(inHigh)}`);
  console.log(`  within LOW recurrence (=1):   ${fmtGap(inLow)}`);

  console.log(`\n  --- by tier ---`);
  const byTier = {};
  for (const tier of ["yellow", "blue"]) {
    const tierObs = obs.filter((o) => o.tier === tier);
    const t = permTestR(tierObs, rMultiple, iterations, seed + 10, hasBadge);
    byTier[tier] = t;
    console.log(`  ${tier.padEnd(7)} n=${tierObs.length.toString().padEnd(6)} ${fmtGap(t)}`);
  }

  console.log(`\n  --- by timeframe ---`);
  const byTf = {};
  for (const tf of LADDER_KEYS) {
    const tfObs = obs.filter((o) => o.timeframe === tf);
    if (tfObs.length === 0) continue;
    const t = permTestR(tfObs, rMultiple, iterations, seed + 20, hasBadge);
    byTf[tf] = t;
    console.log(`  ${tf.padEnd(4)} n=${tfObs.length.toString().padEnd(6)} ${fmtGap(t)}`);
  }

  return { rMultiple, obCount: obs.length, overall, byRecurrence: { high: inHigh, low: inLow }, byTier, byTf };
}

async function main() {
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const boomDb = new DatabaseSync(BOOM_DB_PATH, { readOnly: true });
  const d4mDb = new DatabaseSync(D4M_DB_PATH, { readOnly: true });
  const candlesByTf = {};
  const classificationByTf = {};
  for (const tf of LADDER_KEYS) {
    candlesByTf[tf] = await loadCandles(tf);
    const fullOBs = classifyYellowBlueFullSequence(smcDb, boomDb, tf);
    const badges = d4mDb.prepare("SELECT bar_idx, side FROM badges WHERE timeframe = ? AND side = 'bullish'").all(tf);
    const m = new Map();
    for (const ob of fullOBs) {
      m.set(ob.id, { hasBadge: hasNearbyBadge(badges, ob.longBarIdx), tier: ob.tier, recurrenceCount: ob.recurrence_count });
    }
    classificationByTf[tf] = m;
  }
  smcDb.close(); boomDb.close(); d4mDb.close();

  const obs = await buildOutcomes(candlesByTf, classificationByTf);
  console.log(`${obs.length} yellow/blue full-sequence Boom Hunter bullish order blocks in scope. [badge window=${BADGE_WINDOW_BARS} bars, pre=${PRE_WINDOW} post=${POST_WINDOW} tol=${PRICE_TOLERANCE_PCT}]`);
  console.log(`badge-accompanied: n=${obs.filter((o) => o.hasBadge).length}; not: n=${obs.filter((o) => !o.hasBadge).length}`);

  const results = {};
  for (const r of R_MULTIPLES) results[`${r}R`] = await runForRMultiple(r, obs, ITERATIONS, SEED);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results, obCount: obs.length, preWindow: PRE_WINDOW, postWindow: POST_WINDOW, priceTolerance: PRICE_TOLERANCE_PCT, badgeWindowBars: BADGE_WINDOW_BARS, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `boom_yellow_blue_badge_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

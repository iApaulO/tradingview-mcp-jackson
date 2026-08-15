#!/usr/bin/env node
// The full 4-part sequence iapaulo verified live (24jun Long signal -> price/oscillator divergence
// in that window -> order block forms -> 30jun/1jul Continuation confirms), tested at scale: for
// every bullish SMC order block, check whether a Boom Hunter Long signal preceded it and a
// Continuation event followed it, within real windows matched to the verified instance (~36-42 bars
// on 4h). Classified three ways: "full sequence" (both), "partial" (one of the two), "neither".
// Full-sequence OBs further stratified by the Long signal's TIER, per decision-policy.md's already-
// documented weighting (Lime=highest quality/"QUALITY ENTRIES" in source, Gray=weakest/broadest) --
// testing whether that tiering is empirically justified, not just assumed.
//
// Refined 2026-08-08 per iapaulo: the Long signal is not the entry -- it's just a marker. The OB has
// to actually form AT the price level the signal marked, not merely within some bar window
// regardless of price (the original version only checked bar-distance, which let OBs far from the
// signal's actual price still count as "preceded by" it). Entries throughout are real
// order_block_touches (retests), same as every SMC test tonight -- never the signal bar or the OB's
// own origin bar.
//
// Real order_block_touches + fixed-R methodology throughout, same as every SMC significance test
// tonight -- not MFE. Cross-database join: boom-hunter.db events + smc.db order_blocks/touches.
//
// Usage: node scripts/signal-bus/boom-hunter/long-ob-continuation-significance.js [--iterations=20000] [--r=1,1.5] [--pre-window=50] [--post-window=50] [--price-tolerance=0.01]

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

// Refined 2026-08-08: kept all 4 distinct instead of collapsing blue+yellow into "mid" --
// decision-policy.md ASSUMES blue/yellow are equally weighted (+0.5 each), but that was never
// actually tested against each other, and the earlier lime-vs-mid comparison hid whichever of
// blue/yellow was doing the real work. Now every tier gets its own pairwise comparison.
const TIER = { long_lime: "lime", long_blue: "blue", long_yellow: "yellow", long_gray: "gray" };
const TIER_ORDER = ["lime", "blue", "yellow", "gray"];

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

function classifyOBs(smcDb, boomDb, timeframe, preWindow, priceTolerancePct, postWindow) {
  const obs = smcDb.prepare(
    "SELECT id, origin_bar_idx, origin_time, bar_high, bar_low FROM order_blocks WHERE timeframe = ? AND side = 'bullish'",
  ).all(timeframe);
  const longs = boomDb.prepare(
    "SELECT type, bar_idx, price FROM events WHERE timeframe = ? AND type IN ('long_lime','long_blue','long_yellow','long_gray')",
  ).all(timeframe);
  const continuations = boomDb.prepare(
    "SELECT bar_idx FROM events WHERE timeframe = ? AND type = 'continuation'",
  ).all(timeframe).map((r) => r.bar_idx);

  const classification = new Map();
  for (const ob of obs) {
    // Refined per iapaulo: the signal isn't the entry -- price still has to come PRODUCE the OB "at
    // that level," i.e. the OB's own zone has to actually sit near the price the Long signal marked,
    // not just occur within some bar window regardless of price. Same PRICE_TOLERANCE_PCT convention
    // used for every other cross-indicator (not same-indicator) proximity join tonight.
    const precedingLongs = longs.filter((l) => {
      if (l.bar_idx > ob.origin_bar_idx || ob.origin_bar_idx - l.bar_idx > preWindow) return false;
      const tol = l.price * priceTolerancePct;
      return ob.bar_low - tol <= l.price && l.price <= ob.bar_high + tol;
    });
    const hasContinuationAfter = continuations.some((c) => c >= ob.origin_bar_idx && c - ob.origin_bar_idx <= postWindow);
    const hasLongBefore = precedingLongs.length > 0;

    let bestTier = null;
    if (hasLongBefore) {
      // best (highest-quality) tier among the preceding Longs, closest to the OB if tied
      const tierRank = { lime: 4, blue: 3, yellow: 2, gray: 1 };
      let best = null;
      for (const l of precedingLongs) {
        const t = TIER[l.type];
        if (!best || tierRank[t] > tierRank[TIER[best.type]]) best = l;
      }
      bestTier = TIER[best.type];
    }

    let group;
    if (hasLongBefore && hasContinuationAfter) group = "full";
    else if (hasLongBefore || hasContinuationAfter) group = "partial";
    else group = "neither";

    classification.set(ob.id, { group, tier: bestTier });
  }
  return classification;
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
    if (!ob) continue; // bearish OB touches, not relevant here
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
      const stopPrice = e.ob.bar_low; // bullish only
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
      const c = classification.get(e.ob.id) || { group: "neither", tier: null };
      if (!obOutcomes.has(e.ob.id)) obOutcomes.set(e.ob.id, { group: c.group, tier: c.tier, timeframe: tf, wins: [] });
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
  return { realA, realB, realGap, p };
}

async function runForRMultiple(rMultiple, candlesByTf, classificationByTf, iterations, seed) {
  console.log(`\n=== ${rMultiple}R ===`);
  const obs = await buildOutcomes(rMultiple, candlesByTf, classificationByTf);
  const totalTrades = obs.reduce((s, o) => s + o.wins.length, 0);
  const counts = { full: 0, partial: 0, neither: 0 };
  for (const o of obs) counts[o.group]++;
  console.log(`${obs.length} bullish order blocks (full=${counts.full}, partial=${counts.partial}, neither=${counts.neither}), ${totalTrades} resolved trades.`);

  const fullStats = groupStats(obs, (o) => o.group === "full");
  const partialStats = groupStats(obs, (o) => o.group === "partial");
  const neitherStats = groupStats(obs, (o) => o.group === "neither");
  console.log(`  full sequence (Long -> OB -> Continuation): n=${fullStats.n}, winRate=${fullStats.winRate != null ? (fullStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  console.log(`  partial (one of the two present):           n=${partialStats.n}, winRate=${partialStats.winRate != null ? (partialStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  console.log(`  neither:                                     n=${neitherStats.n}, winRate=${neitherStats.winRate != null ? (neitherStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);

  const vsNeither = permutationTest(obs.filter((o) => o.group !== "partial"), iterations, seed, (o) => o.group === "full");
  const vsPartial = permutationTest(obs.filter((o) => o.group !== "neither"), iterations, seed + 1, (o) => o.group === "full");
  if (vsNeither) console.log(`\n  full vs neither: gap=${(vsNeither.realGap * 100).toFixed(1)}pts p=${vsNeither.p.toFixed(4)}${vsNeither.p < 0.05 ? "*" : ""}`);
  if (vsPartial) console.log(`  full vs partial: gap=${(vsPartial.realGap * 100).toFixed(1)}pts p=${vsPartial.p.toFixed(4)}${vsPartial.p < 0.05 ? "*" : ""}`);

  // Per-timeframe breakdown -- a pooled significant result can mask that no single timeframe
  // independently clears the bar (confirmed real for Boom!/enter2 in boom-hunter-full-signal-
  // significance.js: pooled significant in all 4 slots, split by timeframe only 2 of 4 individual
  // TF/R cells were, always directionally positive though). Reported unconditionally, not a one-off.
  console.log(`\n  --- per timeframe ---`);
  const byTf = {};
  for (const tf of LADDER_KEYS) {
    const tfObs = obs.filter((o) => o.timeframe === tf);
    if (tfObs.length === 0) continue;
    const tfFull = groupStats(tfObs, (o) => o.group === "full");
    const tfVsNeither = permutationTest(tfObs.filter((o) => o.group !== "partial"), iterations, seed + 1000, (o) => o.group === "full");
    const tfVsPartial = permutationTest(tfObs.filter((o) => o.group !== "neither"), iterations, seed + 1001, (o) => o.group === "full");
    byTf[tf] = { full: tfFull, vsNeither: tfVsNeither, vsPartial: tfVsPartial };
    const sN = tfVsNeither && tfVsNeither.p < 0.05 ? "*" : "";
    const sP = tfVsPartial && tfVsPartial.p < 0.05 ? "*" : "";
    console.log(
      `    ${tf.padEnd(4)} full n=${String(tfFull.n).padEnd(6)} winRate=${tfFull.winRate != null ? (tfFull.winRate * 100).toFixed(1) + "%" : "n/a "}` +
      `  vsNeither gap=${tfVsNeither ? (tfVsNeither.realGap * 100).toFixed(1) + "pts p=" + tfVsNeither.p.toFixed(4) + sN : "n/a"}` +
      `  vsPartial gap=${tfVsPartial ? (tfVsPartial.realGap * 100).toFixed(1) + "pts p=" + tfVsPartial.p.toFixed(4) + sP : "n/a"}`,
    );
  }

  console.log(`\n  Within full-sequence OBs, by preceding Long signal tier (all 4, not collapsed):`);
  const fullObs = obs.filter((o) => o.group === "full");
  for (const tier of TIER_ORDER) {
    const s = groupStats(fullObs, (o) => o.tier === tier);
    console.log(`    ${tier.padEnd(6)}: n=${s.n}, winRate=${s.winRate != null ? (s.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  }

  console.log(`\n  All pairwise tier comparisons:`);
  const pairwise = {};
  let seedOffset = 2;
  for (let i = 0; i < TIER_ORDER.length; i++) {
    for (let j = i + 1; j < TIER_ORDER.length; j++) {
      const [tA, tB] = [TIER_ORDER[i], TIER_ORDER[j]];
      const subset = fullObs.filter((o) => o.tier === tA || o.tier === tB);
      const test = permutationTest(subset, iterations, seed + seedOffset++, (o) => o.tier === tA);
      if (!test) continue;
      const key = `${tA}_vs_${tB}`;
      pairwise[key] = test;
      const s = test.p < 0.05 ? "*" : "";
      console.log(`    ${tA} (${(test.realA * 100).toFixed(1)}%) vs ${tB} (${(test.realB * 100).toFixed(1)}%): gap=${(test.realGap * 100).toFixed(1)}pts p=${test.p.toFixed(4)}${s}`);
    }
  }

  return { rMultiple, obCount: obs.length, tradeCount: totalTrades, counts, fullStats, partialStats, neitherStats, vsNeither, vsPartial, pairwise, byTf };
}

export async function runLongObContinuationTest({
  iterations = ITERATIONS, seed = SEED, rMultiples = R_MULTIPLES,
  preWindow = PRE_WINDOW, postWindow = POST_WINDOW, priceTolerance = PRICE_TOLERANCE_PCT,
} = {}) {
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const boomDb = new DatabaseSync(BOOM_DB_PATH, { readOnly: true });
  const candlesByTf = {};
  const classificationByTf = {};
  for (const tf of LADDER_KEYS) {
    candlesByTf[tf] = await loadCandles(tf);
    classificationByTf[tf] = classifyOBs(smcDb, boomDb, tf, preWindow, priceTolerance, postWindow);
  }
  smcDb.close(); boomDb.close();

  const results = {};
  for (const r of rMultiples) results[`${r}R`] = await runForRMultiple(r, candlesByTf, classificationByTf, iterations, seed);
  return { results, preWindow, postWindow, priceTolerance };
}

async function main() {
  const out = await runLongObContinuationTest({});

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { ...out, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `long_ob_continuation_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
}

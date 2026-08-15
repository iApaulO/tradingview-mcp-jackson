#!/usr/bin/env node
// Gap iapaulo caught directly, live on the 1h chart (a yellow Long signal below a solid swing
// CHoCH/BOS, followed by an OB and/or Continuation, itself sitting below a D4M zone) -- the
// Boom Hunter full-sequence test (#60, long-ob-continuation-significance.js) and the "OB at/below
// solid structure" test (smc/ob-at-below-solid-structure-significance.js) were built and
// significance-tested SEPARATELY. Neither checked whether COMBINING them -- a full-sequence Boom
// Hunter OB that ALSO sits at-or-below a solid (swing-scope) CHoCH/BOS -- is stronger than either
// alone (tested, falsified, see significance-register.md #62). Extended per iapaulo's follow-up:
//   1. Add D4M (Divergence-for-Many) as a third layer -- the live example was ALSO below a D4M
//      zone, and that element was scoped out of the first pass deliberately, not by oversight.
//   2. The 60-bar structure window itself was never validated on this dataset -- it was carried
//      forward from an old test on the capped order-block history (see ob-at-below-solid-
//      structure-significance.js's own header). `--sweep` runs the SAME structure-attachment
//      comparison across a range of window sizes instead of just the inherited 60, so the choice
//      is checked rather than assumed. Reported as a full table with an explicit multiple-
//      comparisons disclosure -- sweeping N window sizes and reporting only the best one is
//      exactly the kind of practice this project's register flags elsewhere (#35, #44) as a false-
//      positive risk, not a discovery method.
//
// Reuses, unmodified, the exact validated definitions from the three parent tests/patterns:
//   - "full sequence": classifyFullSequence(), identical to nested-cross-timeframe-significance.js.
//   - "at/below solid structure": isAtBelowSolidStructure(), identical to
//     ob-at-below-solid-structure-significance.js's loadAtBelowAttachment (price ordering,
//     ob.barHigh <= structure.price, scope='swing' only, within a bar window of the OB's origin).
//   - "below a D4M zone": loadD4MBullishZones()/zoneActiveAt(), identical to
//     div-line-retest-double-ob-significance.js (same D4M coverage caveat applies here: that
//     signal-bus has no confirmed zones after ~2026-04-17, inherent censoring, not a bug).
// Same real-touches + fixed-R methodology as the rest of this suite.
//
// Usage:
//   node scripts/signal-bus/cross-confluence/boom-full-sequence-at-below-structure-significance.js [--iterations=20000] [--r=1,1.5] [--pre-window=50] [--post-window=50] [--price-tolerance=0.01] [--structure-window=60]
//   node scripts/signal-bus/cross-confluence/boom-full-sequence-at-below-structure-significance.js --sweep=10,20,30,40,60,80,100,150,200,300 [--r=1] [--iterations=20000]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const BOOM_DB_PATH = new URL("../../../data/signal-bus/boom-hunter.db", import.meta.url);
const D4M_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const MAX_HOLD_BARS = 200;
const TIER_PRIORITY = ["long_lime", "long_blue", "long_yellow", "long_gray", "long_enter4"];
const TIER_LABEL = { long_lime: "lime", long_blue: "blue", long_yellow: "yellow", long_gray: "gray", long_enter4: "enter4" };

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULTIPLES = (args.r || "1,1.5").split(",").map(Number);
const PRE_WINDOW = parseInt(args["pre-window"] || "50", 10);
const POST_WINDOW = parseInt(args["post-window"] || "50", 10);
const PRICE_TOLERANCE_PCT = parseFloat(args["price-tolerance"] || "0.01");
const STRUCTURE_WINDOW_BARS = parseInt(args["structure-window"] || "60", 10);
const D4M_TOLERANCE_PCT = parseFloat(args["d4m-tolerance"] || "0", 10);
const SWEEP_WINDOWS = args.sweep ? args.sweep.split(",").map(Number) : null;

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

// Identical to nested-cross-timeframe-significance.js / build-boom-confluence.js.
function classifyFullSequence(smcDb, boomDb, timeframe) {
  const obs = smcDb.prepare(
    "SELECT id, origin_bar_idx, origin_time, bar_high, bar_low, recurrence_count FROM order_blocks WHERE timeframe = ? AND side = 'bullish'",
  ).all(timeframe);
  const continuations = boomDb.prepare("SELECT bar_idx FROM events WHERE timeframe = ? AND type = 'continuation'").all(timeframe).map((r) => r.bar_idx);
  const longsByType = new Map();
  for (const type of TIER_PRIORITY) longsByType.set(type, boomDb.prepare("SELECT bar_idx, price FROM events WHERE timeframe = ? AND type = ?").all(timeframe, type));

  const fullOBs = [];
  for (const ob of obs) {
    let matchedTier = null;
    for (const type of TIER_PRIORITY) {
      const hit = longsByType.get(type).some((l) => {
        if (l.bar_idx > ob.origin_bar_idx || ob.origin_bar_idx - l.bar_idx > PRE_WINDOW) return false;
        const tol = l.price * PRICE_TOLERANCE_PCT;
        return ob.bar_low - tol <= l.price && l.price <= ob.bar_high + tol;
      });
      if (hit) { matchedTier = TIER_LABEL[type]; break; }
    }
    if (!matchedTier) continue;
    const hasContinuationAfter = continuations.some((c) => c >= ob.origin_bar_idx && c - ob.origin_bar_idx <= POST_WINDOW);
    if (hasContinuationAfter) fullOBs.push({ ...ob, tier: matchedTier });
  }
  return fullOBs;
}

// Window-dependent -- kept separate from the rest of classification so a window sweep only
// recomputes this, not the whole full-sequence/D4M pipeline (see --sweep).
function isAtBelowSolidStructure(structureEvents, ob, windowBars, timeframe) {
  const windowSec = windowBars * BAR_DURATION_SEC[timeframe];
  return structureEvents.some((s) => {
    if (Math.abs(s.time - ob.origin_time) > windowSec) return false;
    return ob.bar_high <= s.price;
  });
}

// Identical to div-line-retest-double-ob-significance.js's loadD4MBullishZones/zoneActiveAt --
// same D4M coverage caveat (no confirmed zones after ~2026-04-17) applies here too.
function loadD4MBullishZones(d4mDb, timeframe) {
  return d4mDb.prepare(
    "SELECT price, created_time as createdTime, expires_time as expiresTime FROM zones WHERE timeframe = ? AND side = 'bullish'",
  ).all(timeframe);
}
function zoneActiveAt(zone, t) {
  return t >= zone.createdTime && t <= (zone.expiresTime ?? Infinity);
}
function isBelowD4MZone(zones, ob) {
  return zones.some((z) => zoneActiveAt(z, ob.origin_time) && ob.bar_high < z.price * (1 - D4M_TOLERANCE_PCT));
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
    const classification = classificationByTf[tf]; // Map ob.id -> { atBelow, belowD4M, tier, recurrenceCount }
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
      if (!obOutcomes.has(e.ob.id)) obOutcomes.set(e.ob.id, { atBelow: c.atBelow, belowD4M: c.belowD4M, tier: c.tier, recurrenceCount: c.recurrenceCount, timeframe: tf, byR: {} });
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
  const atBelow = (o) => o.atBelow;
  const notAtBelow = (o) => !o.atBelow;
  const belowD4M = (o) => o.belowD4M;
  const structureAndD4M = (o) => o.atBelow && o.belowD4M;

  const overall = permTestR(obs, rMultiple, iterations, seed, atBelow);
  console.log(`Full-sequence Boom Hunter OBs: at/below solid structure vs not (structure window=${STRUCTURE_WINDOW_BARS} bars)`);
  console.log(`  at/below solid structure: n=${statsFor(obs, rMultiple, atBelow).n}, winRate=${fmtPct(statsFor(obs, rMultiple, atBelow).winRate)}`);
  console.log(`  not:                      n=${statsFor(obs, rMultiple, notAtBelow).n}, winRate=${fmtPct(statsFor(obs, rMultiple, notAtBelow).winRate)}`);
  console.log(`  ${fmtGap(overall)}`);

  console.log(`\n  --- stratified by recurrence (checking for the same confound that broke the unconditional structure-only test) ---`);
  const highRec = (o) => o.recurrenceCount >= 2, lowRec = (o) => o.recurrenceCount === 1;
  const inHigh = permTestR(obs.filter(highRec), rMultiple, iterations, seed + 1, atBelow);
  const inLow = permTestR(obs.filter(lowRec), rMultiple, iterations, seed + 2, atBelow);
  console.log(`  within HIGH recurrence (>=2): ${fmtGap(inHigh)}`);
  console.log(`  within LOW recurrence (=1):   ${fmtGap(inLow)}`);

  console.log(`\n  --- by tier (yellow highlighted -- iapaulo's live example) ---`);
  const byTier = {};
  for (const tier of ["lime", "blue", "yellow", "gray", "enter4"]) {
    const tierObs = obs.filter((o) => o.tier === tier);
    const t = permTestR(tierObs, rMultiple, iterations, seed + 10, atBelow);
    byTier[tier] = t;
    const marker = tier === "yellow" ? " <-- " : "     ";
    console.log(`  ${marker}${tier.padEnd(7)} n=${tierObs.length.toString().padEnd(6)} ${fmtGap(t)}`);
  }

  console.log(`\n  --- by timeframe (1h highlighted -- iapaulo's live example) ---`);
  const byTf = {};
  for (const tf of LADDER_KEYS) {
    const tfObs = obs.filter((o) => o.timeframe === tf);
    if (tfObs.length === 0) continue;
    const t = permTestR(tfObs, rMultiple, iterations, seed + 20, atBelow);
    byTf[tf] = t;
    const marker = tf === "1h" ? " <-- " : "     ";
    console.log(`  ${marker}${tf.padEnd(4)} n=${tfObs.length.toString().padEnd(6)} ${fmtGap(t)}`);
  }

  console.log(`\n  --- D4M layer (the third element of iapaulo's live example) ---`);
  console.log(`  D4M coverage caveat inherited from div-line-retest-double-ob-significance.js: no confirmed D4M zones after ~2026-04-17 (inherent censoring in that signal-bus), not a bug here.`);
  const belowD4MStats = statsFor(obs, rMultiple, belowD4M), notBelowD4MStats = statsFor(obs, rMultiple, (o) => !o.belowD4M);
  const d4mTest = permTestR(obs, rMultiple, iterations, seed + 30, belowD4M);
  console.log(`  below an active D4M bullish zone: n=${belowD4MStats.n}, winRate=${fmtPct(belowD4MStats.winRate)}`);
  console.log(`  not:                              n=${notBelowD4MStats.n}, winRate=${fmtPct(notBelowD4MStats.winRate)}`);
  console.log(`  D4M alone: ${fmtGap(d4mTest)}`);

  console.log(`\n  --- 2x2: structure x D4M ---`);
  const cells = [
    ["structure + D4M (iapaulo's exact live pattern)", (o) => o.atBelow && o.belowD4M],
    ["structure only", (o) => o.atBelow && !o.belowD4M],
    ["D4M only", (o) => !o.atBelow && o.belowD4M],
    ["neither", (o) => !o.atBelow && !o.belowD4M],
  ];
  const cellStats = {};
  for (const [label, pred] of cells) {
    const s = statsFor(obs, rMultiple, pred);
    cellStats[label] = s;
    console.log(`  ${label.padEnd(45)} n=${String(s.n).padEnd(6)} winRate=${fmtPct(s.winRate)}`);
  }
  const threeWayTest = permTestR(obs, rMultiple, iterations, seed + 31, structureAndD4M);
  console.log(`  structure+D4M vs rest: ${fmtGap(threeWayTest)}`);

  return {
    rMultiple, obCount: obs.length, overall, byRecurrence: { high: inHigh, low: inLow }, byTier, byTf,
    d4m: { alone: d4mTest, cellStats, threeWay: threeWayTest },
  };
}

async function runSweep() {
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const boomDb = new DatabaseSync(BOOM_DB_PATH, { readOnly: true });
  const candlesByTf = {};
  const fullOBsByTf = {};
  const structureEventsByTf = {};
  for (const tf of LADDER_KEYS) {
    candlesByTf[tf] = await loadCandles(tf);
    fullOBsByTf[tf] = classifyFullSequence(smcDb, boomDb, tf);
    structureEventsByTf[tf] = smcDb.prepare(
      "SELECT time, price FROM structure_events WHERE timeframe = ? AND scope = 'swing' AND side = 'bearish' AND type IN ('CHOCH','BOS')",
    ).all(tf);
  }
  smcDb.close(); boomDb.close();

  const r = R_MULTIPLES[0];
  console.log(`Structure-window sensitivity sweep, ${r}R only (the 60-bar default was inherited from an old test on the capped dataset, never validated on this one). Same full-sequence OB population at every window -- only the "at/below" classification changes.`);
  console.log(`Windows tested: ${SWEEP_WINDOWS.join(", ")} bars.\n`);

  const rows = [];
  for (const windowBars of SWEEP_WINDOWS) {
    const classificationByTf = {};
    for (const tf of LADDER_KEYS) {
      const m = new Map();
      for (const ob of fullOBsByTf[tf]) {
        m.set(ob.id, { atBelow: isAtBelowSolidStructure(structureEventsByTf[tf], ob, windowBars, tf), belowD4M: false, tier: ob.tier, recurrenceCount: ob.recurrence_count });
      }
      classificationByTf[tf] = m;
    }
    const obs = await buildOutcomes(candlesByTf, classificationByTf);
    const t = permTestR(obs, r, ITERATIONS, SEED, (o) => o.atBelow);
    const nAtBelow = obs.filter((o) => o.atBelow).length;
    rows.push({ windowBars, nAtBelow, nTotal: obs.length, test: t });
    console.log(`  window=${String(windowBars).padEnd(4)} bars: n(at/below)=${String(nAtBelow).padEnd(6)} of ${obs.length}  ${fmtGap(t)}`);
  }

  const sigCount = rows.filter((r) => r.test && r.test.p < 0.05).length;
  console.log(`\n${sigCount} of ${rows.length} windows clear p<0.05 (~${(rows.length * 0.05).toFixed(1)} expected by chance alone at this count if there's no real effect at any window).`);
  console.log(`Multiple-comparisons disclosure: this sweep tests ${rows.length} window sizes against the same population/outcome. A single significant cell here is NOT sufficient to declare that window "the" validated one -- treat it the way this register treats isolated single-cell hits elsewhere (#35, #44): trust a pattern (monotonic trend, or several adjacent windows agreeing), not one favorable draw.`);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { rMultiple: r, rows, iterations: ITERATIONS, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `structure_window_sweep_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

async function main() {
  if (SWEEP_WINDOWS) return runSweep();

  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const boomDb = new DatabaseSync(BOOM_DB_PATH, { readOnly: true });
  const d4mDb = new DatabaseSync(D4M_DB_PATH, { readOnly: true });
  const candlesByTf = {};
  const classificationByTf = {};
  for (const tf of LADDER_KEYS) {
    candlesByTf[tf] = await loadCandles(tf);
    const fullOBs = classifyFullSequence(smcDb, boomDb, tf);
    const structureEvents = smcDb.prepare(
      "SELECT time, price FROM structure_events WHERE timeframe = ? AND scope = 'swing' AND side = 'bearish' AND type IN ('CHOCH','BOS')",
    ).all(tf);
    const d4mZones = loadD4MBullishZones(d4mDb, tf);
    const m = new Map();
    for (const ob of fullOBs) {
      m.set(ob.id, {
        atBelow: isAtBelowSolidStructure(structureEvents, ob, STRUCTURE_WINDOW_BARS, tf),
        belowD4M: isBelowD4MZone(d4mZones, ob),
        tier: ob.tier,
        recurrenceCount: ob.recurrence_count,
      });
    }
    classificationByTf[tf] = m;
  }
  smcDb.close(); boomDb.close(); d4mDb.close();

  const obs = await buildOutcomes(candlesByTf, classificationByTf);
  console.log(`${obs.length} Boom Hunter full-sequence bullish order blocks in scope. [structure window=${STRUCTURE_WINDOW_BARS} bars, pre=${PRE_WINDOW} post=${POST_WINDOW} tol=${PRICE_TOLERANCE_PCT}, d4m-tolerance=${D4M_TOLERANCE_PCT}]`);
  console.log(`at/below solid structure: n=${obs.filter((o) => o.atBelow).length}; below D4M zone: n=${obs.filter((o) => o.belowD4M).length}; both: n=${obs.filter((o) => o.atBelow && o.belowD4M).length}`);

  const results = {};
  for (const r of R_MULTIPLES) results[`${r}R`] = await runForRMultiple(r, obs, ITERATIONS, SEED);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results, obCount: obs.length, preWindow: PRE_WINDOW, postWindow: POST_WINDOW, priceTolerance: PRICE_TOLERANCE_PCT, structureWindowBars: STRUCTURE_WINDOW_BARS, d4mTolerance: D4M_TOLERANCE_PCT, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `boom_full_sequence_at_below_structure_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });

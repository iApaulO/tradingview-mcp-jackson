#!/usr/bin/env node
// Cross-indicator test (2026-07-27), asked directly as a follow-up to §11's null result: that
// test checked whether SMC structure overlapping a divergence ZONE predicted whether it HOLDS.
// This asks a different question about zones that already BREAK: does the DIRECTION of the break
// align with SMC's prevailing structural bias at that moment?
//
// Breakout direction is implied by which side broke: a bullish/support zone breaking is a
// bearish-direction break (price fell through it); a bearish/resistance zone breaking is a
// bullish-direction break (price rose through it).
//
// SMC bias at a given moment = the side (bullish/bearish) of the most recent structure event
// (BOS or CHoCH) on the SAME timeframe as the touch, at or before the touch's own start_time (no
// look-ahead). Tested separately for scope='swing' (primary -- less noisy, house convention per
// significance-register.md row 8) and scope='internal' (secondary, reported for comparison).
//
// Unit of permutation is the TOUCH, not the zone -- unlike confluence_count (a static zone
// attribute), SMC bias is genuinely time-varying, so the real object being tested is the pairing
// between a specific bias reading and a specific breakout event at a specific time. The null
// shuffles which touch gets which real bias reading, keeping every touch's real breakout
// direction fixed -- this preserves both marginal distributions (BTC's own bullish/bearish base
// rates in both series) and isolates whether the PAIRING carries information.
//
// Usage: node scripts/signal-bus/cross-confluence/breakout-direction-vs-smc-bias.js --iterations=20000

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const DIV_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function loadBrokenTouches() {
  const db = new DatabaseSync(DIV_DB_PATH, { readOnly: true });
  const rows = db.prepare(
    `SELECT t.id as touch_id, t.start_time, z.timeframe, z.side as zone_side
     FROM touches t JOIN zones z ON z.id = t.zone_id
     WHERE t.outcome = 'broken' AND t.ongoing = 0`,
  ).all();
  db.close();
  return rows.map((r) => ({
    ...r,
    breakoutDirection: r.zone_side === "bullish" ? "bearish" : "bullish",
  }));
}

function loadStructureEvents(scope) {
  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const rows = db.prepare(
    `SELECT timeframe, side, time FROM structure_events WHERE scope = ? ORDER BY timeframe, time`,
  ).all(scope);
  db.close();
  const byTf = new Map();
  for (const r of rows) {
    if (!byTf.has(r.timeframe)) byTf.set(r.timeframe, []);
    byTf.get(r.timeframe).push(r);
  }
  return byTf; // each list already sorted by time ascending
}

// Most recent structure event side at or before `t`, on this timeframe's sorted event list.
// Binary search since lists can be tens of thousands long and this runs per touch.
function biasAt(events, t) {
  if (!events || events.length === 0) return null;
  let lo = 0, hi = events.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans === -1 ? null : events[ans].side;
}

function runOneScope(brokenTouches, eventsByTf, iterations, seed) {
  const withBias = [];
  for (const touch of brokenTouches) {
    const bias = biasAt(eventsByTf.get(touch.timeframe), touch.start_time);
    if (bias == null) continue;
    withBias.push({ ...touch, smcBias: bias, aligned: bias === touch.breakoutDirection ? 1 : 0 });
  }

  const realAlignedRate = withBias.reduce((s, w) => s + w.aligned, 0) / withBias.length;

  const realBiasLabels = withBias.map((w) => w.smcBias);
  const realDirections = withBias.map((w) => w.breakoutDirection);

  const rng = mulberry32(seed);
  const permutedRates = [];
  for (let iter = 0; iter < iterations; iter++) {
    const shuffledBias = shuffle(realBiasLabels, rng);
    let aligned = 0;
    for (let i = 0; i < shuffledBias.length; i++) if (shuffledBias[i] === realDirections[i]) aligned++;
    permutedRates.push(aligned / shuffledBias.length);
  }
  permutedRates.sort((a, b) => a - b);
  const p = permutedRates.filter((r) => r >= realAlignedRate).length / permutedRates.length;

  // Descriptive breakdown by zone side (support vs resistance breaks)
  const bySide = {};
  for (const side of ["bullish", "bearish"]) {
    const subset = withBias.filter((w) => w.zone_side === side);
    bySide[side] = { n: subset.length, alignedRate: subset.length ? subset.reduce((s, w) => s + w.aligned, 0) / subset.length : null };
  }

  return {
    totalBrokenTouches: brokenTouches.length,
    touchesWithDefinedBias: withBias.length,
    excludedNoPriorStructure: brokenTouches.length - withBias.length,
    realAlignedRate,
    bySide,
    permutation: {
      iterations,
      seed,
      permutedMean: permutedRates.reduce((s, x) => s + x, 0) / permutedRates.length,
      permutedRange: [permutedRates[0], permutedRates[permutedRates.length - 1]],
      p,
    },
  };
}

export function runBreakoutBiasTest({ iterations = ITERATIONS, seed = SEED, divDbPath = DIV_DB_PATH, smcDbPath = SMC_DB_PATH } = {}) {
  const dbDiv = new DatabaseSync(divDbPath, { readOnly: true });
  const brokenTouches = dbDiv.prepare(
    `SELECT t.id as touch_id, t.start_time, z.timeframe, z.side as zone_side
     FROM touches t JOIN zones z ON z.id = t.zone_id
     WHERE t.outcome = 'broken' AND t.ongoing = 0`,
  ).all().map((r) => ({ ...r, breakoutDirection: r.zone_side === "bullish" ? "bearish" : "bullish" }));
  dbDiv.close();

  const results = {};
  for (const scope of ["swing", "internal"]) {
    const dbSmc = new DatabaseSync(smcDbPath, { readOnly: true });
    const rows = dbSmc.prepare(`SELECT timeframe, side, time FROM structure_events WHERE scope = ? ORDER BY timeframe, time`).all(scope);
    dbSmc.close();
    const byTf = new Map();
    for (const r of rows) { if (!byTf.has(r.timeframe)) byTf.set(r.timeframe, []); byTf.get(r.timeframe).push(r); }
    results[scope] = runOneScope(brokenTouches, byTf, iterations, seed);
  }
  return results;
}

function main() {
  const results = runBreakoutBiasTest({ iterations: ITERATIONS, seed: SEED });
  for (const [scope, r] of Object.entries(results)) {
    console.log(`\n=== SMC bias source: scope='${scope}' ===`);
    console.log(`Broken touches: ${r.totalBrokenTouches} total, ${r.touchesWithDefinedBias} with a defined prior-structure bias (${r.excludedNoPriorStructure} excluded, no prior structure event on that timeframe yet).`);
    console.log(`Real alignment rate (breakout direction == prevailing SMC bias): ${(r.realAlignedRate * 100).toFixed(2)}%`);
    console.log(`  By zone side: bullish/support breaks (n=${r.bySide.bullish.n}) aligned=${(r.bySide.bullish.alignedRate * 100).toFixed(1)}%  |  bearish/resistance breaks (n=${r.bySide.bearish.n}) aligned=${(r.bySide.bearish.alignedRate * 100).toFixed(1)}%`);
    console.log(`Permutation (${r.permutation.iterations} iters, seed=${r.permutation.seed}): permuted mean=${(r.permutation.permutedMean * 100).toFixed(2)}%, range=[${(r.permutation.permutedRange[0] * 100).toFixed(2)}%, ${(r.permutation.permutedRange[1] * 100).toFixed(2)}%]`);
    console.log(`  p=${r.permutation.p.toFixed(4)} ${r.permutation.p < 0.05 ? "(significant at 5%)" : "(NOT significant at 5%)"}`);
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = { results, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `breakout_direction_vs_smc_bias_${out.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(out, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}

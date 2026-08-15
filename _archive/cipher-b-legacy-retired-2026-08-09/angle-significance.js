#!/usr/bin/env node
// Tests iapaulo's actual hypothesis (corrected 2026-08-08 after the first version tested the wrong
// thing -- generic time-to-any-2nd-crossing, not direction-aware): does a divergence line's angle
// predict how long it takes for the FIRST ADVERSE crossing to happen -- the line breaking the wrong
// way relative to what the divergence itself implies?
//
// Favorable/adverse is determined by the line's own slope sign, not a side label, since that's what
// actually determines which side of the line price/oscillator starts on:
//   slope > 0 (rising line)  -> favorable = real stays ABOVE it, adverse = crosses BELOW
//   slope < 0 (falling line) -> favorable = real stays BELOW it, adverse = crosses ABOVE
// This matches the worked examples directly: Feb6->Jun26 (rising, near-horizontal) broke BELOW
// (adverse) quickly = "failed to go bullish"; Jun6->Jun30 (rising, steep) stayed above for weeks
// before its first adverse break, then retested and held.
//
// Right-censoring handled explicitly, not ignored: a divergence with NO recorded adverse crossing
// hasn't failed within available data -- it's still holding, not a missing data point. Reported as
// its own censoring-rate-by-slope breakdown (steep lines being disproportionately never-broken is
// itself evidence, separate from "how long do the ones that DO break take"), and excluded (not
// zero-filled) from the bars-to-adverse-break correlation, same as any survival analysis would.
//
// Slope normalized to oscillator-units/day (not per-bar) before cross-timeframe comparison, same
// reasoning as the first version. Pearson + permutation, same discipline as the rest of this project.
//
// Usage: node scripts/signal-bus/cipher-b/angle-significance.js [--iterations=20000]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const DB_PATH = new URL("../../../data/signal-bus/cipher-b.db", import.meta.url);
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };

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
function pearson(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX, dy = ys[i] - meanY;
    cov += dx * dy; varX += dx * dx; varY += dy * dy;
  }
  return varX === 0 || varY === 0 ? 0 : cov / Math.sqrt(varX * varY);
}
function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch { return "unknown"; }
}

function loadAdverseBreaks(db) {
  const divs = db.prepare(
    "SELECT id, timeframe, source, side, hidden, slope, bar_idx as barIdx, confirm_bar_idx as confirmBarIdx FROM divergences",
  ).all();
  const crossingStmt = db.prepare(
    "SELECT crossing_num, bars_since_confirm, direction FROM divergence_crossings WHERE divergence_id = ? ORDER BY crossing_num ASC",
  );

  const out = [];
  for (const d of divs) {
    const favorableIsAbove = d.slope > 0;
    const adverseDirection = favorableIsAbove ? "above_to_below" : "below_to_above";
    const crossings = crossingStmt.all(d.id);
    const firstAdverse = crossings.find((c) => c.direction === adverseDirection);
    out.push({
      timeframe: d.timeframe, source: d.source, side: d.side, hidden: !!d.hidden,
      slopePerDay: Math.abs(d.slope) * (86400 / BAR_DURATION_SEC[d.timeframe]),
      barsToAdverseBreak: firstAdverse ? firstAdverse.bars_since_confirm : null,
      censored: !firstAdverse,
    });
  }
  return out;
}

function censoringRateBySlopeTercile(rows) {
  const sorted = [...rows].sort((a, b) => a.slopePerDay - b.slopePerDay);
  const third = Math.floor(sorted.length / 3);
  const terciles = [sorted.slice(0, third), sorted.slice(third, 2 * third), sorted.slice(2 * third)];
  return terciles.map((t, i) => ({
    tercile: ["shallow", "mid", "steep"][i],
    n: t.length,
    meanSlope: t.reduce((s, r) => s + r.slopePerDay, 0) / t.length,
    censoredPct: (t.filter((r) => r.censored).length / t.length) * 100,
  }));
}

function testGroup(name, rows, iterations, seed) {
  const observed = rows.filter((r) => !r.censored);
  const censoring = censoringRateBySlopeTercile(rows);
  if (observed.length < 20) return { name, n: rows.length, nObserved: observed.length, tooThin: true, censoring };

  const slopes = observed.map((r) => r.slopePerDay);
  const bars = observed.map((r) => r.barsToAdverseBreak);
  const realR = pearson(slopes, bars);

  const rng = mulberry32(seed);
  const permuted = [];
  for (let i = 0; i < iterations; i++) permuted.push(pearson(slopes, shuffle(bars, rng)));
  permuted.sort((a, b) => a - b);
  const p = permuted.filter((r) => Math.abs(r) >= Math.abs(realR)).length / permuted.length;

  return {
    name, n: rows.length, nObserved: observed.length, tooThin: false,
    meanSlope: slopes.reduce((s, x) => s + x, 0) / slopes.length,
    meanBarsToAdverse: bars.reduce((s, x) => s + x, 0) / bars.length,
    r: realR, p, censoring,
  };
}

export function runAngleSignificanceTest({ iterations = ITERATIONS, seed = SEED, dbPath = DB_PATH } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const all = loadAdverseBreaks(db);
  db.close();

  const sources = ["wt", "wt2nd", "rsi", "stoch"];
  const results = sources.map((source) => testGroup(source, all.filter((r) => r.source === source), iterations, seed));
  const pooled = testGroup("all_sources_pooled", all, iterations, seed);

  return { total: all.length, bySource: results, pooled };
}

function main() {
  const out = runAngleSignificanceTest({ iterations: ITERATIONS, seed: SEED });
  console.log(`${out.total.toLocaleString()} total divergences.\n`);

  console.log("=== Correlation: |slope|/day vs. bars-to-first-adverse-break (observed only) ===");
  console.log("category".padEnd(10) + "n".padEnd(9) + "n_observed".padEnd(12) + "mean bars".padEnd(12) + "r".padEnd(9) + "p".padEnd(8) + "verdict");
  for (const r of [...out.bySource, out.pooled]) {
    if (r.tooThin) { console.log(`${r.name.padEnd(10)}${String(r.n).padEnd(9)}${String(r.nObserved).padEnd(12)}too thin`); continue; }
    const sig = r.p < 0.05 ? "SIGNIFICANT" : "null";
    console.log(
      r.name.padEnd(10) + String(r.n).padEnd(9) + String(r.nObserved).padEnd(12) + r.meanBarsToAdverse.toFixed(1).padEnd(12) +
      r.r.toFixed(4).padEnd(9) + r.p.toFixed(4).padEnd(8) + sig,
    );
  }

  console.log("\n=== Censoring rate by slope tercile (never adversely broken within available data) ===");
  for (const r of [...out.bySource, out.pooled]) {
    console.log(`\n  ${r.name}:`);
    for (const c of r.censoring) {
      console.log(`    ${c.tercile.padEnd(8)} n=${String(c.n).padEnd(7)} mean|slope|/day=${c.meanSlope.toFixed(2).padEnd(10)} censored(never broken)=${c.censoredPct.toFixed(1)}%`);
    }
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { ...out, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `angle_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}

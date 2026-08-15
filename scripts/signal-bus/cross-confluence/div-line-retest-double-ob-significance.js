#!/usr/bin/env node
// Bull-side pattern per iapaulo: a bullish order block below a D4M bullish zone (the mirror of the
// bearish-OB-above-D4M pattern already tested), followed LATER by a SECOND bullish OB that forms
// right at/just under the D4M line itself -- a retest of the line, confirmed by fresh institutional
// interest tighter to the level than the first OB showed. Two legs, not one:
//   OB1: bullish OB, clearly below the D4M zone's price.
//   OB2: a LATER bullish OB, close to the D4M line (tight tolerance) -- the retest confirmation.
// Anchor for forward MFE is OB2 (the retest, the more refined/later signal), not OB1 -- same
// reasoning as the retest-entry fix in ltf-counter-trend-dip-buy-backtest.js: the retest is the
// actionable confirmation, not the initial approach.
//
// Control group: D4M zones with a qualifying OB1 below them but NO later retest OB2 -- tests
// whether requiring the second, tighter retest OB adds anything over the single-OB pattern alone.
//
// D4M coverage caveat still applies (no confirmed zones after ~2026-04-17, inherent censoring).
//
// Usage: node scripts/signal-bus/cross-confluence/div-line-retest-double-ob-significance.js [--window=160] [--retest-tolerance=0.003]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const SMC_DB = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const D4M_DB = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const WINDOW = parseInt(args.window || "160", 10);
const RETEST_TOLERANCE = parseFloat(args["retest-tolerance"] || "0.003");

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
function mean(v) { return v.reduce((s, x) => s + x, 0) / v.length; }
function variance(v, m) { return v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1); }
function normalCdf(z) {
  const b1 = 0.31938153, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429, p = 0.2316419, c = 0.39894228;
  if (z >= 0) { const t = 1 / (1 + p * z); return 1 - c * Math.exp((-z * z) / 2) * t * (t * (t * (t * (t * b5 + b4) + b3) + b2) + b1); }
  return 1 - normalCdf(-z);
}
function welchTTest(a, b) {
  const na = a.length, nb = b.length, ma = mean(a), mb = mean(b);
  const va = variance(a, ma), vb = variance(b, mb);
  const se = Math.sqrt(va / na + vb / nb);
  const t = se === 0 ? 0 : (ma - mb) / se;
  return { na, nb, meanA: ma, meanB: mb, t, p: 2 * (1 - normalCdf(Math.abs(t))) };
}
function computeMfeBaseline(candles, window) {
  const vals = [];
  for (let i = 0; i + window < candles.length; i += 5) {
    const anchor = candles[i].c;
    let hi = -Infinity;
    for (let j = i + 1; j <= i + window; j++) { const c = candles[j].c; if (c > hi) hi = c; }
    vals.push(hi / anchor - 1);
  }
  return vals;
}
function mfeUp(candles, anchorBarIdx, window) {
  const anchor = candles[anchorBarIdx]?.c;
  if (anchor == null) return null;
  let hi = -Infinity, hiIdx = anchorBarIdx;
  for (let j = anchorBarIdx + 1; j <= Math.min(anchorBarIdx + window, candles.length - 1); j++) {
    if (candles[j].c > hi) { hi = candles[j].c; hiIdx = j; }
  }
  if (hi === -Infinity) return null;
  return { mfe: hi / anchor - 1, bars: hiIdx - anchorBarIdx };
}

function loadBullishOBs(db, timeframe) {
  return db.prepare(
    "SELECT id, bar_high as barHigh, bar_low as barLow, origin_bar_idx as originBarIdx, origin_time as originTime FROM order_blocks WHERE timeframe = ? AND side = 'bullish' ORDER BY origin_time ASC",
  ).all(timeframe);
}
function loadD4MBullishZones(db, timeframe) {
  return db.prepare(
    "SELECT price, created_time as createdTime, expires_time as expiresTime FROM zones WHERE timeframe = ? AND side = 'bullish'",
  ).all(timeframe);
}
function zoneActiveAt(zone, t) {
  return t >= zone.createdTime && t <= (zone.expiresTime ?? Infinity);
}

async function runOneTimeframe(timeframe, window, retestTol) {
  const smcDb = new DatabaseSync(SMC_DB, { readOnly: true });
  const d4mDb = new DatabaseSync(D4M_DB, { readOnly: true });
  const candles = await loadCandles(timeframe);
  const baselineMfe = computeMfeBaseline(candles, window);

  const obs = loadBullishOBs(smcDb, timeframe);
  const zones = loadD4MBullishZones(d4mDb, timeframe);

  const withRetest = [], withoutRetest = [];
  for (const zone of zones) {
    // OB1: any bullish OB clearly below the zone's price, active while the zone is active.
    const ob1Candidates = obs.filter((ob) => ob.barHigh < zone.price * (1 - retestTol) && zoneActiveAt(zone, ob.originTime));
    if (ob1Candidates.length === 0) continue;
    const ob1 = ob1Candidates[0]; // earliest qualifying OB1
    // OB2: a LATER bullish OB, tight to the zone's price (the retest).
    const ob2 = obs.find((ob) => ob.originTime > ob1.originTime && Math.abs(ob.barHigh - zone.price) / zone.price <= retestTol && zoneActiveAt(zone, ob.originTime));

    if (ob2) {
      const r = mfeUp(candles, ob2.originBarIdx, window);
      if (r) withRetest.push(r);
    } else {
      const r = mfeUp(candles, ob1.originBarIdx, window);
      if (r) withoutRetest.push(r);
    }
  }

  smcDb.close(); d4mDb.close();

  const cell = { timeframe, nWithRetest: withRetest.length, nWithoutRetest: withoutRetest.length, baselineMfeMean: mean(baselineMfe) };
  for (const [label, group] of [["withRetest", withRetest], ["withoutRetest", withoutRetest]]) {
    if (group.length === 0) { cell[label] = { n: 0 }; continue; }
    const mfeVals = group.map((r) => r.mfe);
    const detail = { n: group.length, meanMfe: mean(mfeVals) };
    if (group.length >= 2) detail.vsBaselineP = welchTTest(mfeVals, baselineMfe).p;
    cell[label] = detail;
  }
  if (withRetest.length >= 2 && withoutRetest.length >= 2) {
    cell.withVsWithoutP = welchTTest(withRetest.map((r) => r.mfe), withoutRetest.map((r) => r.mfe)).p;
  }
  return cell;
}

function fmt(label, c) {
  if (!c || c.n === 0) return `  ${label}: n=0`;
  if (c.n < 2 || c.vsBaselineP == null) return `  ${label}: n=${c.n} MFE=${(c.meanMfe * 100).toFixed(2)}% -- too few for test`;
  const s = c.vsBaselineP < 0.05 ? "*" : "";
  return `  ${label}: n=${c.n} MFE=${(c.meanMfe * 100).toFixed(2)}% vsBaseline p=${c.vsBaselineP.toFixed(3)}${s}`;
}

async function main() {
  console.log(`D4M bullish-line retest via second bullish OB -- MFE window=${WINDOW}, retest tolerance=${(RETEST_TOLERANCE * 100).toFixed(2)}%\n`);
  const results = [];
  for (const tf of LADDER_KEYS) results.push(await runOneTimeframe(tf, WINDOW, RETEST_TOLERANCE));

  for (const r of results) {
    console.log(`=== ${r.timeframe} === (baseline=${(r.baselineMfeMean * 100).toFixed(2)}%)`);
    console.log(fmt("OB1-below-D4M + OB2-retest (2-leg)", r.withRetest));
    console.log(fmt("OB1-below-D4M only (1-leg, no retest)", r.withoutRetest));
    if (r.withVsWithoutP != null) {
      const s = r.withVsWithoutP < 0.05 ? "*" : "";
      console.log(`  withRetest vs withoutRetest: p=${r.withVsWithoutP.toFixed(3)}${s}`);
    }
    console.log("");
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results, window: WINDOW, retestTolerance: RETEST_TOLERANCE, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `div_line_retest_double_ob_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`Saved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}

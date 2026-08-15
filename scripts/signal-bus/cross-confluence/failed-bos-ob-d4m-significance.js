#!/usr/bin/env node
// Refined bear-side pattern per iapaulo: a bearish order block, sitting ABOVE a Divergence-for-Many
// bearish zone, "attached to" a solid (swing-scope) GREEN BOS that subsequently FAILED -- i.e. a
// bullish break of structure that got rejected and reversed, not a clean continuation. A more
// specific version of ob-structure-confluence-significance.js's bearish-OB-above-green-line
// condition: this one requires the green line to be a BOS specifically (not CHoCH -- that's already
// a reversal signal by definition, "failed" doesn't apply the same way), and requires it to have
// FAILED, and adds the D4M leg back in.
//
// "Failed BOS" = a swing-scope bullish BOS whose broken level gets closed back below within
// timeWindowBars -- the classic SMC "bull trap" pattern (structure appeared to break, then didn't
// hold). "Attached to" = the bearish OB's origin sits within the same window of the failure point
// (not the original BOS point) -- the OB represents the rejection/reversal move itself.
//
// D4M coverage note: divergence-for-many.db's zone-confirmation logic has no confirmed zones after
// ~2026-04-17 regardless of candle range (verified earlier tonight, inherent right-censoring, not a
// bug) -- so recent instances of this exact pattern can't be checked against stored D4M zones, only
// older ones. Same caveat as triple-confluence-significance.js.
//
// Usage: node scripts/signal-bus/cross-confluence/failed-bos-ob-d4m-significance.js [--scope=swing] [--window=160] [--time-window-bars=60]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const SMC_DB = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const D4M_DB = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const D4M_PRICE_TOLERANCE_PCT = 0.002; // matching house convention (smc-join.js etc.)

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const SCOPE = args.scope || "swing";
const WINDOW = parseInt(args.window || "160", 10);
const TIME_WINDOW_BARS = parseInt(args["time-window-bars"] || "60", 10);

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
function mean(vals) { return vals.reduce((s, x) => s + x, 0) / vals.length; }
function variance(vals, m) { return vals.reduce((s, x) => s + (x - m) ** 2, 0) / (vals.length - 1); }
function normalCdf(z) {
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
  const p = 0.2316419, c = 0.39894228;
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
    let lo = Infinity;
    for (let j = i + 1; j <= i + window; j++) { const c = candles[j].c; if (c < lo) lo = c; }
    vals.push(1 - lo / anchor); // bear direction only -- this whole pattern is bear-side
  }
  return vals;
}
function mfeDown(candles, anchorBarIdx, window) {
  const anchor = candles[anchorBarIdx]?.c;
  if (anchor == null) return null;
  let lo = Infinity, loIdx = anchorBarIdx;
  for (let j = anchorBarIdx + 1; j <= Math.min(anchorBarIdx + window, candles.length - 1); j++) {
    if (candles[j].c < lo) { lo = candles[j].c; loIdx = j; }
  }
  if (lo === Infinity) return null;
  return { mfe: 1 - lo / anchor, bars: loIdx - anchorBarIdx };
}

function loadBullishSwingBOS(db, timeframe, scope) {
  return db.prepare(
    "SELECT bar_idx as barIdx, time, price FROM structure_events WHERE timeframe = ? AND scope = ? AND type = 'BOS' AND side = 'bullish'",
  ).all(timeframe, scope);
}
function findFailureBar(candles, bosBarIdx, bosPrice, windowBars) {
  for (let j = bosBarIdx + 1; j <= Math.min(bosBarIdx + windowBars, candles.length - 1); j++) {
    if (candles[j].c < bosPrice) return j;
  }
  return null;
}
function loadBearishOBs(db, timeframe) {
  return db.prepare(
    "SELECT id, bar_high as barHigh, bar_low as barLow, origin_bar_idx as originBarIdx, origin_time as originTime FROM order_blocks WHERE timeframe = ? AND side = 'bearish'",
  ).all(timeframe);
}
function loadD4MBearishZones(db, timeframe) {
  return db.prepare(
    "SELECT price, created_time as createdTime, expires_time as expiresTime FROM zones WHERE timeframe = ? AND side = 'bearish'",
  ).all(timeframe);
}
// D4M zone must sit at-or-below the OB's low edge (OB is ABOVE it, allowing a small tolerance band
// rather than requiring the zone to be exactly at the edge -- these are two different indicators'
// price levels, not the same level measured twice) and must be active (not yet expired) at the OB's
// own origin time.
function zoneActiveAbove(zones, timeSec, obLowPrice) {
  return zones.find((z) => {
    if (z.price > obLowPrice * (1 + D4M_PRICE_TOLERANCE_PCT)) return false;
    const start = z.createdTime, end = z.expiresTime ?? Infinity;
    return timeSec >= start && timeSec <= end;
  });
}

async function runOneTimeframe(timeframe, window, timeWindowBars, scope) {
  const smcDb = new DatabaseSync(SMC_DB, { readOnly: true });
  const d4mDb = new DatabaseSync(D4M_DB, { readOnly: true });
  const candles = await loadCandles(timeframe);
  const windowSec = timeWindowBars * BAR_DURATION_SEC[timeframe];

  const bosEvents = loadBullishSwingBOS(smcDb, timeframe, scope);
  const failures = [];
  for (const bos of bosEvents) {
    const failBarIdx = findFailureBar(candles, bos.barIdx, bos.price, timeWindowBars);
    if (failBarIdx != null) failures.push({ ...bos, failBarIdx, failTime: candles[failBarIdx].t });
  }

  const obs = loadBearishOBs(smcDb, timeframe);
  const zones = loadD4MBearishZones(d4mDb, timeframe);
  const baselineMfe = computeMfeBaseline(candles, window);

  const matched = [], unmatchedOBs = [];
  for (const ob of obs) {
    const nearFailure = failures.find((f) => Math.abs(f.failTime - ob.originTime) <= windowSec);
    if (!nearFailure) continue;
    const d4mZone = zoneActiveAbove(zones, ob.originTime, ob.barLow);
    const r = mfeDown(candles, ob.originBarIdx, window);
    if (!r) continue;
    const entry = { mfe: r.mfe, bars: r.bars };
    (d4mZone ? matched : unmatchedOBs).push(entry);
  }

  const cell = {
    timeframe, nBullishSwingBOS: bosEvents.length, nFailedBOS: failures.length,
    nBearishOBsAttachedToFailure: matched.length + unmatchedOBs.length,
    nWithD4M: matched.length, nWithoutD4M: unmatchedOBs.length,
    baselineMfeMean: mean(baselineMfe),
  };
  for (const [label, group] of [["withD4M", matched], ["withoutD4M", unmatchedOBs]]) {
    if (group.length === 0) { cell[label] = { n: 0 }; continue; }
    const mfeVals = group.map((r) => r.mfe);
    const detail = { n: group.length, meanMfe: mean(mfeVals) };
    if (group.length >= 2) {
      const c = welchTTest(mfeVals, baselineMfe);
      detail.vsBaselineP = c.p;
    }
    cell[label] = detail;
  }
  if (matched.length >= 2 && unmatchedOBs.length >= 2) {
    const c = welchTTest(matched.map((r) => r.mfe), unmatchedOBs.map((r) => r.mfe));
    cell.withD4MvsWithoutP = c.p;
  }

  smcDb.close(); d4mDb.close();
  return cell;
}

function fmt(label, c) {
  if (!c || c.n === 0) return `  ${label}: n=0`;
  if (c.n < 2 || c.vsBaselineP == null) return `  ${label}: n=${c.n} MFE=${(c.meanMfe * 100).toFixed(2)}% -- too few for test`;
  const s = c.vsBaselineP < 0.05 ? "*" : "";
  return `  ${label}: n=${c.n} MFE=${(c.meanMfe * 100).toFixed(2)}% vsBaseline p=${c.vsBaselineP.toFixed(3)}${s}`;
}

async function main() {
  console.log(`Failed BOS + bearish OB + D4M bearish zone -- scope=${SCOPE}, MFE window=${WINDOW}, pairing window=${TIME_WINDOW_BARS} bars\n`);
  const results = [];
  for (const tf of LADDER_KEYS) results.push(await runOneTimeframe(tf, WINDOW, TIME_WINDOW_BARS, SCOPE));

  for (const r of results) {
    console.log(`=== ${r.timeframe} === (bullish swing BOS: ${r.nBullishSwingBOS}, failed: ${r.nFailedBOS}, bearish OBs attached to a failure: ${r.nBearishOBsAttachedToFailure}, baseline=${(r.baselineMfeMean * 100).toFixed(2)}%)`);
    console.log(fmt("with D4M bearish zone above OB   ", r.withD4M));
    console.log(fmt("without D4M zone (structure only)", r.withoutD4M));
    if (r.withD4MvsWithoutP != null) {
      const s = r.withD4MvsWithoutP < 0.05 ? "*" : "";
      console.log(`  withD4M vs withoutD4M: p=${r.withD4MvsWithoutP.toFixed(3)}${s}`);
    }
    console.log("");
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results, scope: SCOPE, window: WINDOW, timeWindowBars: TIME_WINDOW_BARS, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `failed_bos_ob_d4m_significance_${SCOPE}_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`Saved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}

export { runOneTimeframe };

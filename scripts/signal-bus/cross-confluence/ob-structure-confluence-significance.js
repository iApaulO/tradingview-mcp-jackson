#!/usr/bin/env node
// Simpler, direct pattern per iapaulo: a bullish order block forming BELOW a solid (swing-scope) red
// CHoCH line as a strong bullish condition -- does it hold, and is a solid red BOS line just as
// strong? Mirrored for bears: bearish OB above a solid green CHoCH/BOS. SMC-only (order_blocks +
// structure_events), no Cipher B or D4M involved -- deliberately simpler than tonight's earlier
// 3-signal joins, which kept coming back either null or too data-starved to read.
//
// "Solid" = scope='swing' on the structure event, verified from source (smart-money-concepts-luxalgo.pine
// line 562: lineStyle = internal ? dashed : solid). NOT applied to the OB's own scope -- iapaulo's
// wording qualifies the CHoCH/BOS line, not the order block.
//
// Pairing: for each OB, the nearest RED/GREEN swing structure event (CHOCH or BOS, opposite side to
// the OB's own side, matching the "OB below red line" / "OB above green line" wording) such that the
// OB's zone sits on the correct side of that structure event's price, within a generous time window
// (structure events are rare at swing scope, so this errs wide rather than missing real pairs).
// Three groups per side: paired with CHOCH, paired with BOS, no qualifying pair (isolated OB, the
// control -- tests whether the structure confluence adds anything over a plain OB at all).
//
// Started scoped to daily, then validated across the full ladder (--ladder=true) with both swing
// and internal scope -- real, significant on 3h both sides (cleanest), 4h/1d bearish, holding up
// after a baseline-drift check (see ob_structure findings in this suite's dashboard). Moved into
// this significance suite 2026-08-08 as the one validated positive finding among the various
// confluence combinations tested here.
//
// Usage: node scripts/signal-bus/cross-confluence/ob-structure-confluence-significance.js [--timeframe=1d|--ladder=true] [--scope=swing|internal] [--window=160] [--time-window-bars=60]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const SMC_DB = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const HORIZONS = [5, 10, 20, 40];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TIMEFRAME = args.timeframe || "1d";
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
function tTestOneSample(vals) {
  const n = vals.length, m = mean(vals);
  const se = Math.sqrt(variance(vals, m) / n);
  const t = se === 0 ? 0 : m / se;
  return { n, mean: m, t, p: 2 * (1 - normalCdf(Math.abs(t))) };
}
// FIXED: one-sample-vs-zero on MFE is not a meaningful test (any long window shows "significant"
// MFE vs 0 from volatility alone, worse with tiny n where low variance makes p look deceptively
// small). Welch two-sample vs the isolated group (or the unconditional baseline) is the real test --
// same lesson as price-outcome-significance.js's baseline-drift fix, applied to MFE this time.
function welchTTest(a, b) {
  const na = a.length, nb = b.length, ma = mean(a), mb = mean(b);
  const va = variance(a, ma), vb = variance(b, mb);
  const se = Math.sqrt(va / na + vb / nb);
  const t = se === 0 ? 0 : (ma - mb) / se;
  return { na, nb, meanA: ma, meanB: mb, t, p: 2 * (1 - normalCdf(Math.abs(t))) };
}
function computeMfeBaseline(candles, window, direction) {
  const vals = [];
  for (let i = 0; i + window < candles.length; i += 5) {
    const anchor = candles[i].c;
    let best = direction === "up" ? -Infinity : Infinity;
    for (let j = i + 1; j <= i + window; j++) { const c = candles[j].c; if (direction === "up" ? c > best : c < best) best = c; }
    vals.push(direction === "up" ? best / anchor - 1 : 1 - best / anchor);
  }
  return vals;
}
function mfeForEvent(candles, anchorBarIdx, window, direction) {
  const anchor = candles[anchorBarIdx]?.c;
  if (anchor == null) return null;
  let best = direction === "up" ? -Infinity : Infinity, bestIdx = anchorBarIdx;
  for (let j = anchorBarIdx + 1; j <= Math.min(anchorBarIdx + window, candles.length - 1); j++) {
    const c = candles[j].c;
    if (direction === "up" ? c > best : c < best) { best = c; bestIdx = j; }
  }
  if (best === -Infinity || best === Infinity) return null;
  return { mfe: direction === "up" ? best / anchor - 1 : 1 - best / anchor, bars: bestIdx - anchorBarIdx };
}

function loadOBs(db, timeframe, side) {
  return db.prepare(
    "SELECT id, scope, bar_high as barHigh, bar_low as barLow, origin_bar_idx as originBarIdx, origin_time as originTime, " +
    "created_bar_idx as createdBarIdx, created_time as createdTime FROM order_blocks WHERE timeframe = ? AND side = ?",
  ).all(timeframe, side);
}
function loadStructure(db, timeframe, side, scope) {
  return db.prepare(
    "SELECT type, bar_idx as barIdx, time, price FROM structure_events WHERE timeframe = ? AND scope = ? AND side = ?",
  ).all(timeframe, scope, side);
}

// Nearest qualifying swing structure event, "ATTACHED to" the OB -- corrected 2026-08-08 (second
// correction on this function): the first version required the structure price to sit strictly
// below/above the OB's own zone. Verified live on the actual 4h chart that this misses real cases --
// a CHoCH/BOS sitting INSIDE the OB's [barLow, barHigh] range (or within a small tolerance band
// around it) is still "attached to" the OB in the sense iapaulo means, not a different, lesser
// pattern. Matches the looser proximity-based "attached" definition already used in
// failed-bos-ob-d4m-significance.js, rather than the strict ordering this file used before.
const ATTACH_PRICE_TOLERANCE_PCT = 0.003;
function findPair(ob, structureEvents, side, windowSec) {
  let best = null, bestDist = Infinity, bestType = null;
  const tol = ob.barHigh * ATTACH_PRICE_TOLERANCE_PCT;
  for (const s of structureEvents) {
    const qualifies = s.price >= ob.barLow - tol && s.price <= ob.barHigh + tol;
    if (!qualifies) continue;
    const dist = Math.abs(s.time - ob.originTime);
    if (dist > windowSec) continue;
    if (dist < bestDist) { bestDist = dist; best = s; bestType = s.type; }
  }
  return best ? { ...best, type: bestType } : null;
}

async function runOneTimeframe(timeframe, window, timeWindowBars, scope) {
  const db = new DatabaseSync(SMC_DB, { readOnly: true });
  const candles = await loadCandles(timeframe);
  const windowSec = timeWindowBars * BAR_DURATION_SEC[timeframe];

  const results = [];
  for (const side of ["bullish", "bearish"]) {
    const direction = side === "bullish" ? "up" : "down";
    const structureSide = side === "bullish" ? "bearish" : "bullish"; // red line under bull OB, green line over bear OB
    const obs = loadOBs(db, timeframe, side);
    // CHOCH + BOS pooled -- either type satisfies "a solid/dashed red/green line" per iapaulo's phrasing.
    // scope='swing' (solid) or 'internal' (dashed) -- internal added on request for statistical power
    // where swing is too sparse (daily: 4-6 swing events vs 26-51 internal, per earlier count).
    const structureEvents = loadStructure(db, timeframe, structureSide, scope);
    const baselineMfe = computeMfeBaseline(candles, window, direction);

    // Anchor at ORIGIN, not created_bar_idx -- created_bar_idx is when the algorithm CONFIRMS the OB,
    // several bars after the actual candle, so anchoring there was measuring return AFTER part of the
    // reactive move already happened (same class of error as the recross-anchor mistake earlier
    // tonight). origin_bar_idx is the real OB candle itself.
    const groups = { paired: [], isolated: [] };
    let nCHOCHType = 0, nBOSType = 0;
    for (const ob of obs) {
      const r = mfeForEvent(candles, ob.originBarIdx, window, direction);
      if (!r) continue;
      const fixed = {};
      for (const h of HORIZONS) {
        const anchor = candles[ob.originBarIdx]?.c, fut = candles[ob.originBarIdx + h]?.c;
        if (anchor != null && fut != null) { const raw = fut / anchor - 1; fixed[h] = side === "bullish" ? raw : -raw; }
      }
      const entry = { mfe: r.mfe, bars: r.bars, fixed, obId: ob.id };
      const pair = findPair(ob, structureEvents, side, windowSec);
      if (pair) {
        groups.paired.push(entry);
        if (pair.type === "CHOCH") nCHOCHType++; else nBOSType++;
      } else {
        groups.isolated.push(entry);
      }
    }

    const cell = {
      side, timeframe, nPaired: groups.paired.length, nIsolated: groups.isolated.length,
      nPairedByType: { choch: nCHOCHType, bos: nBOSType },
      nStructureEventsAvailable: structureEvents.length, baselineMfeMean: mean(baselineMfe),
    };
    for (const [label, group] of Object.entries(groups)) {
      if (group.length === 0) { cell[label] = { n: 0 }; continue; }
      const mfeVals = group.map((r) => r.mfe);
      const detail = { n: group.length, meanMfe: mean(mfeVals), meanBars: mean(group.map((r) => r.bars)) };
      // vs baseline (always computable, large n) -- the meaningful comparison, not one-sample-vs-zero.
      // Requires n>=2 (variance undefined at n=1, and welchTTest would divide by zero -> NaN -> the
      // normalCdf recursion never terminates).
      if (group.length >= 2) {
        const vsBaseline = welchTTest(mfeVals, baselineMfe);
        detail.vsBaselineP = vsBaseline.p; detail.vsBaselineT = vsBaseline.t;
      }
      // vs isolated group too, when it's not the isolated group itself and both sides have enough n.
      if (label !== "isolated" && groups.isolated.length >= 2 && group.length >= 2) {
        const vsIsolated = welchTTest(mfeVals, groups.isolated.map((r) => r.mfe));
        detail.vsIsolatedP = vsIsolated.p; detail.vsIsolatedT = vsIsolated.t;
      }
      cell[label] = detail;
    }
    results.push(cell);
  }
  db.close();
  return { timeframe, window, timeWindowBars, results };
}

export async function runObStructureTest({ timeframe = TIMEFRAME, window = WINDOW, timeWindowBars = TIME_WINDOW_BARS, allTimeframes = false, scope = "swing" } = {}) {
  if (!allTimeframes) return runOneTimeframe(timeframe, window, timeWindowBars, scope);
  const byTf = {};
  for (const tf of ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"]) byTf[tf] = await runOneTimeframe(tf, window, timeWindowBars, scope);
  return byTf;
}

function fmtCell(label, c, baselineMfeMean) {
  if (!c || c.n === 0) return `  ${label}: n=0`;
  if (c.n < 2 || c.vsBaselineP == null) return `  ${label}: n=${c.n}, MFE=${(c.meanMfe * 100).toFixed(2)}% -- too few instances, no test possible`;
  const s1 = c.vsBaselineP < 0.05 ? "*" : "";
  let line = `  ${label}: n=${c.n} MFE=${(c.meanMfe * 100).toFixed(2)}% (baseline=${(baselineMfeMean * 100).toFixed(2)}%) vsBaseline p=${c.vsBaselineP.toFixed(3)}${s1}`;
  if (c.vsIsolatedP != null) {
    const s2 = c.vsIsolatedP < 0.05 ? "*" : "";
    line += ` | vsIsolated p=${c.vsIsolatedP.toFixed(3)}${s2}`;
  }
  return line;
}

function main() {
  const allTimeframes = args.timeframe === "all" || args.ladder != null;
  const scope = args.scope || "swing";
  runObStructureTest({ timeframe: TIMEFRAME, window: WINDOW, timeWindowBars: TIME_WINDOW_BARS, allTimeframes, scope }).then((out) => {
    const runs = allTimeframes ? Object.values(out) : [out];
    console.log(`scope=${scope}`);
    for (const run of runs) {
      console.log(`\n########## ${run.timeframe} -- MFE window=${run.window} bars, pairing window=${run.timeWindowBars} bars ##########`);
      for (const r of run.results) {
        console.log(`\n=== ${r.side} OB (swing structure events available: ${r.nStructureEventsAvailable}, of paired: CHOCH=${r.nPairedByType.choch} BOS=${r.nPairedByType.bos}) ===`);
        console.log(fmtCell("paired (CHOCH or BOS)", r.paired, r.baselineMfeMean));
        console.log(fmtCell("isolated (no pair)   ", r.isolated, r.baselineMfeMean));
      }
    }

    const RESULTS_DIR = new URL("results/", import.meta.url);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const payload = { out, git_commit: gitCommit(), generated_at: new Date().toISOString() };
    const fname = `ob_structure_confluence_significance_${allTimeframes ? "ladder" : TIMEFRAME}_${scope}_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
    writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
    console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
  });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}

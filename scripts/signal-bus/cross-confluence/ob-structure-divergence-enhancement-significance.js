#!/usr/bin/env node
// Third leg on top of the already-confirmed OB + swing/internal CHoCH-or-BOS pattern
// (ob-structure-confluence-significance.js): does a nearby SAME-SIDE Cipher B divergence enhance it
// further? Splits the "paired" (OB+structure confluence) population into paired+divergence vs
// paired-only, comparing MFE (baseline-relative, same drift-aware framing already validated).
//
// Divergence proximity: same side as the OB (bullish OB -> bullish divergence, bearish OB ->
// bearish divergence -- reinforcing, not the opposite-side "OB below/above a line" relationship
// used for structure pairing), WT regular divergence only (`vmc-cipher-b.db`'s `zones`, kind=
// 'regular' -- migrated 2026-08-09 off the retired `cipher-b.db`, which covered 4 oscillator
// sources; that breadth isn't available in the current implementation, a real scope narrowing, see
// the CIPHER_DB constant below), within the same time window used for OB-structure pairing and a
// generous 1% price tolerance (divergence pivots and OB zones aren't the same kind of level, so the
// tight 0.2% used for same-indicator joins elsewhere is too strict here).
//
// Usage: node scripts/signal-bus/cross-confluence/ob-structure-divergence-enhancement-significance.js [--scope=internal] [--window=160] [--time-window-bars=60]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const SMC_DB = new URL("../../../data/signal-bus/smc.db", import.meta.url);
// MIGRATED 2026-08-09: the legacy `cipher-b.db` (separate implementation, `divergences` table,
// per-instance rows across 4 oscillator sources) is retired -- stale (last built 2026-08-08, not
// part of the active rebuild pipeline) and superseded by `vmc-cipher-b/`, the actively-maintained
// implementation (regular_add fix, #31-59 in significance-register.md). Real schema difference,
// not just a path swap: `vmc-cipher-b.db`'s `zones` table is WT-divergence-only (no multi-source
// rows), promoted/kind-classified ('regular'/'regular_add'/'hidden') rather than raw per-instance.
// Uses kind='regular' -- the established preferred choice for a standalone/confirmation join per
// significance-register.md #51 ("regular alone is now the deliberately correct filter"). This is a
// real scope narrowing from the original "any of wt/wt2nd/rsi/stoch" -- disclosed here, not silent.
const CIPHER_DB = new URL("../../../data/signal-bus/vmc-cipher-b.db", import.meta.url);
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const DIV_PRICE_TOLERANCE_PCT = 0.01;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const SCOPE = args.scope || "internal";
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
    "SELECT id, bar_high as barHigh, bar_low as barLow, origin_bar_idx as originBarIdx, origin_time as originTime " +
    "FROM order_blocks WHERE timeframe = ? AND side = ?",
  ).all(timeframe, side);
}
function loadStructure(db, timeframe, side, scope) {
  return db.prepare(
    "SELECT bar_idx as barIdx, time, price FROM structure_events WHERE timeframe = ? AND scope = ? AND side = ? AND type IN ('CHOCH','BOS')",
  ).all(timeframe, scope, side);
}
function findStructurePair(ob, structureEvents, side, windowSec) {
  let best = null, bestDist = Infinity;
  for (const s of structureEvents) {
    const qualifies = side === "bullish" ? ob.barHigh <= s.price : ob.barLow >= s.price;
    if (!qualifies) continue;
    const dist = Math.abs(s.time - ob.originTime);
    if (dist > windowSec) continue;
    if (dist < bestDist) { bestDist = dist; best = s; }
  }
  return best;
}
function loadCipherDivergences(db, timeframe, obSide) {
  // zones.side already uses 'bullish'/'bearish' (unlike the old divergences.side 'bull'/'bear') --
  // no translation needed. kind='regular' only, see the CIPHER_DB migration note above.
  return db.prepare(
    "SELECT price as price, confirmed_time as confirmTime FROM zones WHERE timeframe = ? AND side = ? AND kind = 'regular'",
  ).all(timeframe, obSide);
}
function hasNearbyDivergence(ob, divs, windowSec) {
  const obPrice = (ob.barHigh + ob.barLow) / 2;
  return divs.some((d) => {
    if (Math.abs(d.confirmTime - ob.originTime) > windowSec) return false;
    return Math.abs(d.price - obPrice) / obPrice <= DIV_PRICE_TOLERANCE_PCT;
  });
}

async function runOneTimeframe(timeframe, window, timeWindowBars, scope) {
  const smcDb = new DatabaseSync(SMC_DB, { readOnly: true });
  const cipherDb = new DatabaseSync(CIPHER_DB, { readOnly: true });
  const candles = await loadCandles(timeframe);
  const windowSec = timeWindowBars * BAR_DURATION_SEC[timeframe];

  const results = [];
  for (const side of ["bullish", "bearish"]) {
    const direction = side === "bullish" ? "up" : "down";
    const structureSide = side === "bullish" ? "bearish" : "bullish";
    const obs = loadOBs(smcDb, timeframe, side);
    const structureEvents = loadStructure(smcDb, timeframe, structureSide, scope);
    const divs = loadCipherDivergences(cipherDb, timeframe, side);
    const baselineMfe = computeMfeBaseline(candles, window, direction);

    const groups = { withDiv: [], withoutDiv: [] };
    let nPairedTotal = 0;
    for (const ob of obs) {
      const structurePair = findStructurePair(ob, structureEvents, side, windowSec);
      if (!structurePair) continue; // only looking within the already-confirmed OB+structure population
      nPairedTotal++;
      const r = mfeForEvent(candles, ob.originBarIdx, window, direction);
      if (!r) continue;
      const entry = { mfe: r.mfe, bars: r.bars };
      const divNearby = hasNearbyDivergence(ob, divs, windowSec);
      (divNearby ? groups.withDiv : groups.withoutDiv).push(entry);
    }

    const cell = { side, timeframe, nPairedTotal, nWithDiv: groups.withDiv.length, nWithoutDiv: groups.withoutDiv.length, baselineMfeMean: mean(baselineMfe) };
    for (const [label, group] of Object.entries(groups)) {
      if (group.length === 0) { cell[label] = { n: 0 }; continue; }
      const mfeVals = group.map((r) => r.mfe);
      const detail = { n: group.length, meanMfe: mean(mfeVals) };
      if (group.length >= 2) {
        const vsBaseline = welchTTest(mfeVals, baselineMfe);
        detail.vsBaselineP = vsBaseline.p;
      }
      cell[label] = detail;
    }
    if (groups.withDiv.length >= 2 && groups.withoutDiv.length >= 2) {
      const c = welchTTest(groups.withDiv.map((r) => r.mfe), groups.withoutDiv.map((r) => r.mfe));
      cell.withDivVsWithoutP = c.p;
    }
    results.push(cell);
  }
  smcDb.close(); cipherDb.close();
  return { timeframe, window, timeWindowBars, scope, results };
}

function fmt(label, c) {
  if (!c || c.n === 0) return `  ${label}: n=0`;
  if (c.n < 2 || c.vsBaselineP == null) return `  ${label}: n=${c.n} MFE=${(c.meanMfe * 100).toFixed(2)}% -- too few for test`;
  const s = c.vsBaselineP < 0.05 ? "*" : "";
  return `  ${label}: n=${c.n} MFE=${(c.meanMfe * 100).toFixed(2)}% vsBaseline p=${c.vsBaselineP.toFixed(3)}${s}`;
}

async function main() {
  const runs = [];
  for (const tf of LADDER_KEYS) runs.push(await runOneTimeframe(tf, WINDOW, TIME_WINDOW_BARS, SCOPE));
  console.log(`OB+structure(${SCOPE}) population, split by nearby same-side Cipher B divergence -- window=${WINDOW}, pairing window=${TIME_WINDOW_BARS} bars\n`);
  for (const run of runs) {
    console.log(`########## ${run.timeframe} ##########`);
    for (const r of run.results) {
      console.log(`\n=== ${r.side} (paired-with-structure pool n=${r.nPairedTotal}, baseline=${(r.baselineMfeMean * 100).toFixed(2)}%) ===`);
      console.log(fmt("with nearby divergence   ", r.withDiv));
      console.log(fmt("without nearby divergence", r.withoutDiv));
      if (r.withDivVsWithoutP != null) {
        const s = r.withDivVsWithoutP < 0.05 ? "*" : "";
        console.log(`  withDiv vs withoutDiv: p=${r.withDivVsWithoutP.toFixed(3)}${s}`);
      }
    }
    console.log("");
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { runs, scope: SCOPE, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `ob_structure_divergence_enhancement_${SCOPE}_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`Saved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}

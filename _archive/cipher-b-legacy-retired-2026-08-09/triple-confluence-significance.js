#!/usr/bin/env node
// The actual pattern from the 4h 30apr26/13may26 example: a horizontal (shallow-tercile) Cipher B
// divergence, forming near a same-side SMC SWING-scope BOS (solid line -- verified from source,
// smart-money-concepts-luxalgo.pine line 562), with a bearish Divergence-for-Many zone nearby above
// it. Three separate signal buses, joined on real stored data, not a Cipher-B-only line pattern
// (which tested null three ways already -- see cross-recross / compound-confluence /
// persistent-line-crossing-significance.js). Source left unrestricted (wt/wt2nd/rsi/stoch all count)
// per iapaulo's "we can test it on rsi and stochastic as well".
//
// NOTE on D4M coverage: divergence-for-many.db's zone-confirmation logic needs forward bars to
// confirm a zone, so it has NO confirmed zones after ~2026-04-17 regardless of how recent the candle
// data is (verified: rebuilding produced identical results) -- this is inherent right-censoring at
// the data boundary, same category as "held" divergences elsewhere in this project, not a bug. That
// means the exact 4/30-5/16 anecdote can't itself be checked against this table; this test instead
// uses that anecdote to define the PATTERN SHAPE and checks it against every other real instance in
// history where a D4M zone did get confirmed.
//
// Same 0.2% price / +-20 bar tolerance as smc-join.js -- not a new number, matching house convention.
//
// Confluence = divergence's own pivot price within tolerance of a same-side-consistent swing BOS
// AND within tolerance of an opposite-side (bear div sees bullish D4M zone or vice versa -- per the
// worked example, a BULL div sits near a BEARISH D4M zone) D4M zone active at that time.
//
// Usage: node scripts/signal-bus/cipher-b/triple-confluence-significance.js [--side=bull] [--window=160]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const CIPHER_DB = new URL("../../../data/signal-bus/cipher-b.db", import.meta.url);
const SMC_DB = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const D4M_DB = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const PRICE_TOLERANCE_PCT = 0.002;
const TIME_WINDOW_BARS = 20;
const HORIZONS = [5, 10, 20, 40];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const SIDE = args.side || "bull";
const WINDOW = parseInt(args.window || "160", 10);

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
function welchTTest(a, b) {
  const na = a.length, nb = b.length, ma = mean(a), mb = mean(b);
  const va = variance(a, ma), vb = variance(b, mb);
  const se = Math.sqrt(va / na + vb / nb);
  const t = se === 0 ? 0 : (ma - mb) / se;
  return { na, nb, meanA: ma, meanB: mb, t, p: 2 * (1 - normalCdf(Math.abs(t))) };
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

function assignTerciles(rows) {
  const sorted = [...rows].sort((a, b) => a.slopePerDay - b.slopePerDay);
  const third = Math.floor(sorted.length / 3);
  sorted.forEach((r, i) => { r._tercile = i < third ? "shallow" : i < 2 * third ? "mid" : "steep"; });
}

function loadDivergences(cipherDb, timeframe, side) {
  const rows = cipherDb.prepare(
    "SELECT id, source, hidden, slope, bar_idx as barIdx, time, price_val as price, confirm_bar_idx as confirmBarIdx, confirm_time as confirmTime " +
    "FROM divergences WHERE timeframe = ? AND side = ?",
  ).all(timeframe, side);
  for (const r of rows) r.slopePerDay = Math.abs(r.slope) * (86400 / BAR_DURATION_SEC[timeframe]);
  assignTerciles(rows);
  return rows;
}

function loadSwingBOS(smcDb, timeframe, side) {
  return smcDb.prepare(
    "SELECT bar_idx as barIdx, time, price FROM structure_events WHERE timeframe = ? AND scope = 'swing' AND type = 'BOS' AND side = ?",
  ).all(timeframe, side);
}

function loadOppositeZones(d4mDb, timeframe, oppositeSide) {
  return d4mDb.prepare(
    "SELECT price, created_bar_idx as createdBarIdx, created_time as createdTime, expires_bar_idx as expiresBarIdx, expires_time as expiresTime, status " +
    "FROM zones WHERE timeframe = ? AND side = ?",
  ).all(timeframe, oppositeSide);
}

function nearestWithinTolerance(events, barIdx, timeSec, price, windowSec) {
  let best = null, bestDiff = Infinity;
  for (const e of events) {
    const t = e.time ?? e.createdTime;
    if (Math.abs(t - timeSec) > windowSec) continue;
    const priceDiffPct = Math.abs(e.price - price) / price;
    if (priceDiffPct > PRICE_TOLERANCE_PCT) continue;
    if (priceDiffPct < bestDiff) { bestDiff = priceDiffPct; best = e; }
  }
  return best;
}
function activeZoneNear(zones, timeSec, price) {
  return zones.find((z) => {
    const priceDiffPct = Math.abs(z.price - price) / price;
    if (priceDiffPct > PRICE_TOLERANCE_PCT) return false;
    const start = z.createdTime;
    const end = z.expiresTime ?? Infinity;
    return timeSec >= start && timeSec <= end;
  });
}

export async function runTripleConfluenceTest({ side = SIDE, window = WINDOW } = {}) {
  const direction = side === "bull" ? "up" : "down";
  const oppositeSide = side === "bull" ? "bearish" : "bullish";
  const bosSide = side === "bull" ? "bullish" : "bearish";

  const cipherDb = new DatabaseSync(CIPHER_DB, { readOnly: true });
  const smcDb = new DatabaseSync(SMC_DB, { readOnly: true });
  const d4mDb = new DatabaseSync(D4M_DB, { readOnly: true });

  const results = [];
  for (const timeframe of LADDER_KEYS) {
    const candles = await loadCandles(timeframe);
    const windowSec = TIME_WINDOW_BARS * BAR_DURATION_SEC[timeframe];
    const divs = loadDivergences(cipherDb, timeframe, side).filter((d) => d._tercile === "shallow");
    const bos = loadSwingBOS(smcDb, timeframe, bosSide);
    const zones = loadOppositeZones(d4mDb, timeframe, oppositeSide);

    const confluence = [], isolated = [];
    for (const d of divs) {
      const nearBOS = nearestWithinTolerance(bos, d.barIdx, d.time, d.price, windowSec);
      const nearZone = activeZoneNear(zones, d.confirmTime, d.price);
      const r = mfeForEvent(candles, d.confirmBarIdx, window, direction);
      if (!r) continue;
      const fixed = {};
      for (const h of HORIZONS) {
        const anchor = candles[d.confirmBarIdx]?.c, fut = candles[d.confirmBarIdx + h]?.c;
        if (anchor != null && fut != null) { const raw = fut / anchor - 1; fixed[h] = side === "bull" ? raw : -raw; }
      }
      const entry = { mfe: r.mfe, bars: r.bars, fixed };
      (nearBOS && nearZone ? confluence : isolated).push(entry);
    }

    const mfeBaseline = computeMfeBaseline(candles, window, direction);
    const cell = { timeframe, nConfluence: confluence.length, nIsolated: isolated.length, baselineMfeMean: mean(mfeBaseline) };
    if (confluence.length >= 5 && isolated.length >= 10) {
      const c = welchTTest(confluence.map((r) => r.mfe), isolated.map((r) => r.mfe));
      cell.confluenceMeanMfe = c.meanA; cell.isolatedMeanMfe = c.meanB; cell.t = c.t; cell.p = c.p;
      cell.horizons = {};
      for (const h of HORIZONS) {
        const cv = confluence.map((r) => r.fixed[h]).filter((v) => v != null);
        const iv = isolated.map((r) => r.fixed[h]).filter((v) => v != null);
        if (cv.length >= 5 && iv.length >= 10) {
          const ch = welchTTest(cv, iv);
          cell.horizons[h] = { meanConfluence: ch.meanA, meanIsolated: ch.meanB, t: ch.t, p: ch.p };
        }
      }
    } else {
      cell.tooThin = true;
    }
    results.push(cell);
  }

  cipherDb.close(); smcDb.close(); d4mDb.close();
  return { side, window, results };
}

function main() {
  runTripleConfluenceTest({ side: SIDE, window: WINDOW }).then((out) => {
    console.log(`Triple confluence test -- side=${out.side}, window=${out.window} bars (shallow/horizontal divs only)\n`);
    for (const r of out.results) {
      console.log(`=== ${r.timeframe} ===  baseline MFE=${(r.baselineMfeMean * 100).toFixed(2)}%`);
      if (r.tooThin) { console.log(`  too thin: nConfluence=${r.nConfluence} nIsolated=${r.nIsolated}\n`); continue; }
      const star = r.p < 0.05 ? "*" : "";
      console.log(`  confluence (n=${r.nConfluence}): MFE=${(r.confluenceMeanMfe * 100).toFixed(2)}%`);
      console.log(`  isolated   (n=${r.nIsolated}): MFE=${(r.isolatedMeanMfe * 100).toFixed(2)}%`);
      console.log(`  t=${r.t.toFixed(3)} p=${r.p.toFixed(3)}${star}`);
      for (const h of HORIZONS) {
        const c = r.horizons[h];
        if (!c) continue;
        const s = c.p < 0.05 ? "*" : "";
        console.log(`    N${h}: confluence=${(c.meanConfluence * 100).toFixed(2)}% isolated=${(c.meanIsolated * 100).toFixed(2)}% (p=${c.p.toFixed(3)}${s})`);
      }
      console.log("");
    }

    const RESULTS_DIR = new URL("results/", import.meta.url);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const payload = { ...out, git_commit: gitCommit(), generated_at: new Date().toISOString() };
    const fname = `triple_confluence_significance_${out.side}_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
    writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
    console.log(`Saved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
  });
}

main();

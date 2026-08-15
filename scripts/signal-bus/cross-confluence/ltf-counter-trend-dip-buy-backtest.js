#!/usr/bin/env node
// The mechanical system this whole thread converges on: NOT "short the failed-BOS bearish OB", but
// the reframe discovered by checking HTF context -- on 5m, every instance of {failed bullish swing
// BOS -> attached bearish OB -> D4M bearish zone above it} occurred during a 1h uptrend (21/21).
// That's a counter-trend dip inside a larger uptrend, not an independent bearish setup -- so the
// tradeable direction is LONG (buy the dip, betting on HTF resumption), not short.
//
// System:
//   Context: HTF (1h) trend up (20-bar close-vs-close).
//   Setup:   bullish swing BOS on the entry timeframe fails (closes back below within 60 bars).
//   Trigger: a bearish OB forms attached to that failure (within 200 bars of the failure point).
//   Filter:  a D4M bearish zone sits at/below the OB (OB is above it) -- the compound confluence
//            that (on 5m) marked the cleanest, most trend-conditioned instances.
//   Entry:   LONG at the OB's origin bar close.
//   Stop:    OB's own low (bar_low) -- if price breaks back below the level that formed the OB, the
//            dip-buy thesis is invalidated.
//   Targets: R-multiples of entry-to-stop risk (1R/2R/3R), first-touch within the MFE window.
//
// Baseline: matched random entries taken ONLY during the same HTF-up context (not the generic
// unconditional baseline used elsewhere tonight) -- since HTF trend context is now known to matter
// enormously, comparing against a trend-blind baseline would reintroduce exactly the confound this
// system exists to correct for.
//
// Usage: node scripts/signal-bus/cross-confluence/ltf-counter-trend-dip-buy-backtest.js [--timeframe=5m] [--htf=1h] [--window=160]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const SMC_DB = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const D4M_DB = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const D4M_TOL = 0.002;
const FAILURE_WINDOW_BARS = 60;
const ATTACH_WINDOW_BARS = 200;
const R_MULTIPLES = [1, 2, 3];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TIMEFRAME = args.timeframe || "5m";
const HTF = args.htf || "1h";
const WINDOW = parseInt(args.window || "160", 10);
const HTF_TREND_BARS = parseInt(args["htf-trend-bars"] || "20", 10);

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

function buildHtfTrendIndex(htfCandles, trendBars) {
  // For any unix time, was the HTF trend up? Returns a function(t) -> "up"|"down"|null.
  const times = htfCandles.map((c) => c.t);
  return function (t) {
    let lo = 0, hi = times.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx < trendBars) return null;
    return htfCandles[idx].c > htfCandles[idx - trendBars].c ? "up" : "down";
  };
}

function findFailedBullishSwingBOS(db, timeframe, candles) {
  const bos = db.prepare(
    "SELECT bar_idx as barIdx, time, price FROM structure_events WHERE timeframe = ? AND scope = 'swing' AND type = 'BOS' AND side = 'bullish'",
  ).all(timeframe);
  const failures = [];
  for (const b of bos) {
    for (let j = b.barIdx + 1; j <= Math.min(b.barIdx + FAILURE_WINDOW_BARS, candles.length - 1); j++) {
      if (candles[j].c < b.price) { failures.push({ ...b, failBarIdx: j, failTime: candles[j].t }); break; }
    }
  }
  return failures;
}

// Retest entry: price must first move AWAY from the OB (confirming it as a valid block -- that's
// the impulsive down-leg this whole system exists to wait out), then come back and touch the zone.
// Requires at least MIN_DEPARTURE_BARS of separation before a "touch" counts as a real retest, not
// just the origin bar's own wick (which would trivially "touch" the zone it's defined from).
const MIN_DEPARTURE_BARS = 3;
function findRetestEntry(candles, ob, window) {
  for (let j = ob.originBarIdx + MIN_DEPARTURE_BARS; j <= Math.min(ob.originBarIdx + window, candles.length - 1); j++) {
    const bar = candles[j];
    if (bar.l <= ob.barHigh && bar.h >= ob.barLow) {
      // retest touch -- limit-order-style entry at the zone's own top edge, capped by the touching
      // bar's actual high (can't fill better than what traded).
      const entryPrice = Math.min(ob.barHigh, bar.h);
      return { entryBarIdx: j, entryPrice };
    }
  }
  return null;
}

function findSetups(smcDb, d4mDb, timeframe, candles, htfTrendAt, window) {
  const failures = findFailedBullishSwingBOS(smcDb, timeframe, candles);
  const obs = smcDb.prepare(
    "SELECT id, bar_high as barHigh, bar_low as barLow, origin_bar_idx as originBarIdx, origin_time as originTime FROM order_blocks WHERE timeframe = ? AND side = 'bearish'",
  ).all(timeframe);
  const zones = d4mDb.prepare(
    "SELECT price, created_time as createdTime, expires_time as expiresTime FROM zones WHERE timeframe = ? AND side = 'bearish'",
  ).all(timeframe);
  const windowSec = ATTACH_WINDOW_BARS * BAR_DURATION_SEC[timeframe];

  const setups = [];
  let nNoRetest = 0;
  for (const ob of obs) {
    const f = failures.find((f) => Math.abs(f.failTime - ob.originTime) <= windowSec);
    if (!f) continue;
    const zone = zones.find((z) => z.price <= ob.barLow * (1 + D4M_TOL) && ob.originTime >= z.createdTime && ob.originTime <= (z.expiresTime ?? Infinity));
    if (!zone) continue; // this system specifically requires the D4M leg
    const retest = findRetestEntry(candles, ob, window);
    if (!retest) { nNoRetest++; continue; }
    const htf = htfTrendAt(candles[retest.entryBarIdx].t);
    setups.push({ ob, htf, retest });
  }
  console.log(`  (${nNoRetest} setups had no retest touch within ${window} bars -- excluded, not a valid trigger)`);
  return setups;
}

// FIXED: original version flagged hitR[i] as soon as a target was touched, THEN separately flagged
// stoppedOut if price later closed below stop -- both could end up true on the same trade (target
// touched first, price gave it all back later), and the console mislabeled that combination as
// "stopped out (never hit 1R)" even when 1R had, in fact, been hit. In a real single-exit trade you
// leave at whichever comes first. Rewritten to record WHEN (bar offset) the stop and each target are
// first touched, so a win is target-time < stop-time (or stop never reached), not just "was it ever
// touched at some point in the window."
function simulateLongTrade(candles, entryBarIdx, entryPrice, stopPrice, window) {
  const risk = entryPrice - stopPrice;
  if (risk <= 0) return null; // malformed (OB low at/above entry)
  const targets = R_MULTIPLES.map((r) => entryPrice + r * risk);
  const targetBarOffset = R_MULTIPLES.map(() => null);
  let stopBarOffset = null;
  for (let j = entryBarIdx + 1; j <= Math.min(entryBarIdx + window, candles.length - 1); j++) {
    const c = candles[j].c;
    const offset = j - entryBarIdx;
    if (stopBarOffset == null && c <= stopPrice) stopBarOffset = offset;
    for (let i = 0; i < targets.length; i++) if (targetBarOffset[i] == null && c >= targets[i]) targetBarOffset[i] = offset;
    if (stopBarOffset != null) break; // once stopped, no further targets can be "won" in a real single-exit trade
  }
  const wonR = targetBarOffset.map((t) => t != null && (stopBarOffset == null || t < stopBarOffset));
  return { risk, wonR, stopped: stopBarOffset != null, stopBarOffset };
}

function randomBaselineTrades(candles, htfTrendAt, window, n, seed) {
  // Matched baseline: entries only during HTF-up context, same window, same R-sizing logic but
  // risk-per-trade drawn from the REAL setup population's own risk distribution (passed in by caller)
  // isn't available here generically -- caller supplies riskSamples.
  let a = seed >>> 0;
  const rng = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const eligible = [];
  for (let i = window; i < candles.length - window; i++) {
    if (htfTrendAt(candles[i].t) === "up") eligible.push(i);
  }
  const picks = [];
  for (let i = 0; i < n && eligible.length > 0; i++) picks.push(eligible[Math.floor(rng() * eligible.length)]);
  return picks;
}

async function main() {
  const smcDb = new DatabaseSync(SMC_DB, { readOnly: true });
  const d4mDb = new DatabaseSync(D4M_DB, { readOnly: true });
  const candles = await loadCandles(TIMEFRAME);
  const htfCandles = await loadCandles(HTF);
  const htfTrendAt = buildHtfTrendIndex(htfCandles, HTF_TREND_BARS);

  const setups = findSetups(smcDb, d4mDb, TIMEFRAME, candles, htfTrendAt, WINDOW);
  const upSetups = setups.filter((s) => s.htf === "up");
  const downSetups = setups.filter((s) => s.htf === "down");

  console.log(`${TIMEFRAME}: ${setups.length} total setups (failed bullish swing BOS + attached bearish OB + D4M zone above), HTF(${HTF})=up: ${upSetups.length}, HTF=down: ${downSetups.length}\n`);

  function runGroup(label, group) {
    const trades = [];
    for (const s of group) {
      const entryBarIdx = s.retest.entryBarIdx;
      const entryPrice = s.retest.entryPrice;
      const stopPrice = s.ob.barLow;
      const t = simulateLongTrade(candles, entryBarIdx, entryPrice, stopPrice, WINDOW);
      if (t) trades.push(t);
    }
    if (trades.length === 0) { console.log(`${label}: n=0`); return null; }
    console.log(`${label}: n=${trades.length}`);
    for (let i = 0; i < R_MULTIPLES.length; i++) {
      const wins = trades.filter((t) => t.wonR[i]).length;
      console.log(`  won ${R_MULTIPLES[i]}R (target reached before stop): ${wins}/${trades.length} = ${(wins / trades.length * 100).toFixed(1)}%`);
    }
    const stopped = trades.filter((t) => t.stopped).length;
    console.log(`  stop touched at some point in the window: ${stopped}/${trades.length} = ${(stopped / trades.length * 100).toFixed(1)}% (includes trades that won a target first, then later gave it back -- not the same as a losing trade)`);
    return { trades };
  }

  const upResult = runGroup("LONG setups (HTF up context, the actual system)", upSetups);
  console.log("");
  runGroup("LONG setups (HTF down context -- for contrast, off-thesis)", downSetups);

  // Matched random-entry baseline, same HTF-up filter, n = same as upSetups, same window, but with
  // risk sized from the real setups' own risk distribution (so R-multiples are comparable).
  if (upResult) {
    console.log("\n--- Matched baseline: random long entries during the same HTF-up context ---");
    const riskPctSamples = upSetups.map((s) => {
      const entryPrice = candles[s.ob.originBarIdx]?.c;
      return entryPrice != null ? (entryPrice - s.ob.barLow) / entryPrice : null;
    }).filter((v) => v != null);
    const picks = randomBaselineTrades(candles, htfTrendAt, WINDOW, upSetups.length * 5, 42); // oversample for stabler baseline rate
    const baselineTrades = [];
    let a = 12345;
    const rng = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (const idx of picks) {
      const entryPrice = candles[idx].c;
      const riskPct = riskPctSamples[Math.floor(rng() * riskPctSamples.length)];
      const stopPrice = entryPrice * (1 - riskPct);
      const t = simulateLongTrade(candles, idx, entryPrice, stopPrice, WINDOW);
      if (t) baselineTrades.push(t);
    }
    console.log(`baseline n=${baselineTrades.length} (${upSetups.length}x oversampled random HTF-up entries, risk drawn from real setups' own risk distribution)`);
    for (let i = 0; i < R_MULTIPLES.length; i++) {
      const hits = baselineTrades.filter((t) => t.wonR[i]).length;
      const rate = hits / baselineTrades.length;
      const setupHits = upResult.trades.filter((t) => t.wonR[i]).length;
      const setupRate = setupHits / upResult.trades.length;
      // two-proportion z-test
      const pooled = (hits + setupHits) / (baselineTrades.length + upResult.trades.length);
      const se = Math.sqrt(pooled * (1 - pooled) * (1 / baselineTrades.length + 1 / upResult.trades.length));
      const z = se === 0 ? 0 : (setupRate - rate) / se;
      const p = 2 * (1 - normalCdf(Math.abs(z)));
      console.log(`  baseline hit ${R_MULTIPLES[i]}R: ${(rate * 100).toFixed(1)}%  vs setup ${(setupRate * 100).toFixed(1)}%  (z=${z.toFixed(2)}, p=${p.toFixed(3)}${p < 0.05 ? '*' : ''})`);
    }
  }

  smcDb.close(); d4mDb.close();

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `ltf_counter_trend_dip_buy_${TIMEFRAME}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify({ timeframe: TIMEFRAME, htf: HTF, window: WINDOW, nUpSetups: upSetups.length, nDownSetups: downSetups.length, git_commit: gitCommit(), generated_at: new Date().toISOString() }, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main();
